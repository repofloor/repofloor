/**
 * Who is looking at an office right now.
 *
 * Three rules from ADR 0002 are enforced here rather than remembered:
 *
 * 1. **Never persisted.** Presence lives in this process and dies with it. The
 *    snapshot is derived from signed GitHub deliveries; who has a tab open is not
 *    that, and writing it there would make the snapshot something else.
 * 2. **No new protocol.** Arrival is `actor.upsert`, departure is `actor.leave`, and
 *    a viewer with no other activity lands on `idle`, which the protocol already
 *    defines as "present but no activity". `actor.upsert` carries no status, so a
 *    viewer the webhooks show as `coding` is not downgraded to watching.
 * 3. **Not a surveillance tool.** An entry records that someone is here and when we
 *    last heard from their socket — the TTL input. There is no arrival time and no
 *    duration, because nothing reads one and nothing should be able to.
 *
 * The TTL exists for sockets that die without a close frame. A browser that is simply
 * quiet is still here; `touch` is driven by the socket's own liveness (`ws` pongs),
 * not by user activity.
 */

import type { Actor, OfficeEvent } from "@repofloor/protocol";

export interface PresenceEntry {
  actor: Actor;
  /** Last sign of life from the socket. The only timestamp we keep. */
  lastHeard: number;
  /** How many sockets this viewer has open — two tabs are one person. */
  sockets: number;
}

export interface PresenceOptions {
  /** How long after the last sign of life a viewer is dropped. Default 90s. */
  ttlMs?: number | undefined;
  now?: (() => number) | undefined;
}

export const DEFAULT_PRESENCE_TTL_MS = 90_000;

/** What changed, so the hub can broadcast exactly that and nothing more. */
export interface PresenceChange {
  arrived: Actor[];
  departed: string[];
}

const EMPTY: PresenceChange = { arrived: [], departed: [] };

/** Presence for one office. */
export class OfficePresence {
  readonly #entries = new Map<string, PresenceEntry>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: PresenceOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_PRESENCE_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Everyone currently here. */
  actors(): Actor[] {
    return [...this.#entries.values()].map((entry) => entry.actor);
  }

  has(login: string): boolean {
    return this.#entries.has(login);
  }

  /**
   * A socket arrived. The change is empty when this viewer was already here on
   * another tab — the floor should not blink because someone opened a second one.
   */
  join(actor: Actor): PresenceChange {
    const existing = this.#entries.get(actor.id);
    if (existing) {
      existing.sockets += 1;
      existing.lastHeard = this.#now();
      existing.actor = { ...existing.actor, ...actor };
      return EMPTY;
    }
    this.#entries.set(actor.id, { actor, lastHeard: this.#now(), sockets: 1 });
    return { arrived: [actor], departed: [] };
  }

  /** A socket closed. Only the last one for that viewer is a departure. */
  leave(login: string): PresenceChange {
    const entry = this.#entries.get(login);
    if (!entry) return EMPTY;
    entry.sockets -= 1;
    if (entry.sockets > 0) return EMPTY;
    this.#entries.delete(login);
    return { arrived: [], departed: [login] };
  }

  /** A sign of life. */
  touch(login: string): void {
    const entry = this.#entries.get(login);
    if (entry) entry.lastHeard = this.#now();
  }

  /** Drop whoever we have not heard from inside the TTL. */
  expire(): PresenceChange {
    const cutoff = this.#now() - this.#ttlMs;
    const departed: string[] = [];
    for (const [login, entry] of this.#entries) {
      if (entry.lastHeard <= cutoff) {
        this.#entries.delete(login);
        departed.push(login);
      }
    }
    return departed.length > 0 ? { arrived: [], departed } : EMPTY;
  }
}

export function isEmptyChange(change: PresenceChange): boolean {
  return change.arrived.length === 0 && change.departed.length === 0;
}

/**
 * Turn a presence change into the events the engine already understands.
 *
 * `knownToOffice` is the set of actor ids the *persisted* snapshot has. A departure is
 * only announced for a viewer who is not one of them: telling the floor that someone
 * went offline because they closed a tab, while GitHub says they just pushed, would
 * be a lie the renderer then draws.
 *
 * Event ids are prefixed `presence:` and are not derived from a delivery, because
 * these events are never stored or deduplicated — they are a live overlay.
 */
export function presenceEvents(
  officeId: string,
  change: PresenceChange,
  at: string,
  knownToOffice: ReadonlySet<string>,
): OfficeEvent[] {
  const events: OfficeEvent[] = [];

  for (const actor of change.arrived) {
    events.push({ id: `presence:join:${officeId}:${actor.id}:${at}`, at, officeId, type: "actor.upsert", actor });
  }
  for (const login of change.departed) {
    if (knownToOffice.has(login)) continue;
    events.push({ id: `presence:leave:${officeId}:${login}:${at}`, at, officeId, type: "actor.leave", actorId: login });
  }

  return events;
}
