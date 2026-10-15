/**
 * `EventPublisher` over Postgres `LISTEN`/`NOTIFY` (ADR 0002).
 *
 * The publishing half lives here, next to the interface it implements, because
 * `apps/api` is what publishes. The listening half is `PostgresEventSubscriber`
 * below, which `apps/realtime` runs: one dedicated connection, held outside the pool
 * for the life of the process.
 *
 * Two things shape this file:
 *
 * - **A `NOTIFY` payload is capped at 8000 bytes.** An `OfficeState` for a busy repo
 *   is larger, so a notification carries the events when they fit and a bare pointer
 *   when they do not. A subscriber that gets a pointer loads the snapshot itself and
 *   the browser does a full `setState` instead of animating each event.
 * - **`NOTIFY` is not durable.** Nothing listening means nothing delivered. That is
 *   fine and deliberate: the snapshot in the database is still correct, and realtime
 *   is a speed-up over polling, never the source of truth.
 */

import type { OfficeEvent } from "@repofloor/protocol";
import type { Queryable } from "./db.js";
import { errorFields, silentLogger, type Logger } from "./log.js";
import type { EventPublisher, OfficeUpdate } from "./publisher.js";

/** The channel every office update travels on. Postgres identifier, so no dots. */
export const OFFICE_CHANNEL = "repofloor_office";

/**
 * Postgres refuses a `NOTIFY` payload of 8000 bytes or more. We stay under a slightly
 * lower bar so that the margin is ours, not the server's, and a payload at the edge
 * degrades predictably instead of raising at runtime.
 */
export const MAX_NOTIFY_BYTES = 7000;

/**
 * What travels on the channel. `events` is absent when the update did not fit, which
 * is the subscriber's instruction to go and read the snapshot.
 */
export interface OfficeNotification {
  officeId: string;
  events?: OfficeEvent[];
}

/** Serialize an update for the channel, dropping the events if they do not fit. */
export function encodeNotification(update: Pick<OfficeUpdate, "officeId" | "events">): string {
  const whole = JSON.stringify({ officeId: update.officeId, events: update.events });
  if (Buffer.byteLength(whole, "utf8") <= MAX_NOTIFY_BYTES) return whole;
  return JSON.stringify({ officeId: update.officeId });
}

/**
 * Parse a payload off the channel. Returns undefined for anything malformed: this is
 * data from another process, and a bad line must not take the listener down.
 */
export function decodeNotification(payload: string | undefined): OfficeNotification | undefined {
  if (!payload) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const officeId = (parsed as Record<string, unknown>)["officeId"];
  if (typeof officeId !== "string" || officeId.length === 0) return undefined;

  const events = (parsed as Record<string, unknown>)["events"];
  return Array.isArray(events) ? { officeId, events: events as OfficeEvent[] } : { officeId };
}

export interface PostgresEventPublisherOptions {
  channel?: string | undefined;
  logger?: Logger | undefined;
}

/**
 * Publishes to the channel. Fire-and-forget by contract: a failure here is logged and
 * swallowed, because a webhook that was reduced and saved must still be acknowledged
 * to GitHub. Losing the push means a client waits for its next poll, not that an event
 * is lost.
 */
export class PostgresEventPublisher implements EventPublisher {
  readonly #db: Queryable;
  readonly #channel: string;
  readonly #log: Logger;

  constructor(db: Queryable, options: PostgresEventPublisherOptions = {}) {
    this.#db = db;
    this.#channel = options.channel ?? OFFICE_CHANNEL;
    this.#log = options.logger ?? silentLogger;
  }

  async publish(update: OfficeUpdate): Promise<void> {
    const payload = encodeNotification(update);
    try {
      // `pg_notify` rather than `NOTIFY`, because the latter takes no parameters and
      // would mean interpolating a payload into SQL.
      await this.#db.query("select pg_notify($1, $2)", [this.#channel, payload]);
    } catch (err) {
      this.#log.error("notify failed", { officeId: update.officeId, ...errorFields(err) });
    }
  }
}

/** A connection that can `LISTEN`: `pg.Client`, or a pool client, or a test double. */
export interface ListenConnection extends Queryable {
  on(event: "notification", listener: (message: { channel: string; payload?: string }) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  end?(): Promise<void>;
}

export interface PostgresEventSubscriberOptions {
  channel?: string | undefined;
  logger?: Logger | undefined;
  /** Opens a fresh connection. Called again on every reconnect. */
  connect: () => Promise<ListenConnection>;
  /** Backoff between reconnects, in ms. Defaults to 1s doubling to 30s. */
  retryDelaysMs?: number[] | undefined;
  /** Injected in tests so a reconnect does not actually wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export type NotificationHandler = (notification: OfficeNotification) => void;

const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * The listening half. Holds one connection open, re-opens it with backoff when it
 * drops, and hands every parsed notification to the handler.
 *
 * On reconnect it cannot know what it missed, so it reports a gap: the handler is
 * called with `{officeId}` for nothing in particular — instead `onResync` fires, and
 * the caller resyncs the offices it cares about by snapshot. Guessing would be worse
 * than saying "I do not know".
 */
export class PostgresEventSubscriber {
  readonly #channel: string;
  readonly #log: Logger;
  readonly #connect: () => Promise<ListenConnection>;
  readonly #retryDelays: number[];
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #handlers = new Set<NotificationHandler>();
  readonly #resyncHandlers = new Set<() => void>();

  #connection: ListenConnection | undefined;
  #running = false;
  #attempt = 0;
  /** Resolves once the first `LISTEN` is in place; tests await it. */
  #ready: Promise<void> | undefined;

  constructor(options: PostgresEventSubscriberOptions) {
    this.#channel = options.channel ?? OFFICE_CHANNEL;
    this.#log = options.logger ?? silentLogger;
    this.#connect = options.connect;
    this.#retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()));
  }

  /** Every notification on the channel. Returns an unsubscribe function. */
  onNotification(handler: NotificationHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  /**
   * Fired after a reconnect, never on the first connect: it means "there is a gap you
   * cannot see, go and reload". Returns an unsubscribe function.
   */
  onResync(handler: () => void): () => void {
    this.#resyncHandlers.add(handler);
    return () => this.#resyncHandlers.delete(handler);
  }

  /** Connect and `LISTEN`. Resolves once the first listen is in place. */
  async start(): Promise<void> {
    if (this.#running) return this.#ready;
    this.#running = true;
    this.#ready = this.#open(false);
    return this.#ready;
  }

  async stop(): Promise<void> {
    this.#running = false;
    const connection = this.#connection;
    this.#connection = undefined;
    await connection?.end?.().catch(() => {});
  }

  async #open(isReconnect: boolean): Promise<void> {
    while (this.#running) {
      try {
        const connection = await this.#connect();
        connection.on("notification", (message) => {
          if (message.channel !== this.#channel) return;
          const notification = decodeNotification(message.payload);
          if (!notification) {
            this.#log.warn("undecodable notification dropped", { channel: message.channel });
            return;
          }
          for (const handler of this.#handlers) handler(notification);
        });
        // A dropped connection is normal operation, not an exception: reconnect.
        connection.on("error", (err) => {
          this.#log.warn("listen connection lost", errorFields(err));
          if (this.#connection === connection) {
            this.#connection = undefined;
            void this.#open(true);
          }
        });

        await connection.query(`listen ${quoteIdentifier(this.#channel)}`);
        this.#connection = connection;
        this.#attempt = 0;
        this.#log.info("listening for office notifications", { channel: this.#channel });

        // Whatever happened while we were away is unknowable, so say so rather than
        // pretend the stream was continuous.
        if (isReconnect) for (const handler of this.#resyncHandlers) handler();
        return;
      } catch (err) {
        const delay = this.#retryDelays[Math.min(this.#attempt, this.#retryDelays.length - 1)] ?? 30_000;
        this.#attempt += 1;
        this.#log.warn("could not listen, retrying", { delayMs: delay, ...errorFields(err) });
        await this.#sleep(delay);
        isReconnect = true;
      }
    }
  }
}

/**
 * Postgres identifiers are not parameterizable, and `LISTEN` takes one. The channel is
 * ours rather than user input, but quoting it costs nothing and removes the question.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
