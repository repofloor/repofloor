/**
 * Office storage.
 *
 * Two implementations live behind this interface: `InMemoryOfficeStore` here and
 * `PostgresOfficeStore` (ADR 0001) in `store-postgres.ts`. Nothing above this file
 * knows which one it is talking to.
 */

import type { OfficeEvent, OfficeState } from "@repofloor/protocol";

export interface OfficeStore {
  /** Current snapshot for "owner/repo", or undefined if the office is unknown. */
  load(officeId: string): Promise<OfficeState | undefined>;
  save(officeId: string, state: OfficeState): Promise<void>;
  /**
   * Record an event id as applied. Returns true the first time, false if it was
   * already applied — callers skip the event when it returns false.
   */
  markDelivered(eventId: string): Promise<boolean>;
  /** Office ids currently held, for a listing endpoint and for tests. */
  list(): Promise<string[]>;
  /**
   * Keep these events, so the office can be shown as it stood at any past moment
   * (ADR 0003). Idempotent on the event id: a backfill reaching a commit a webhook
   * already delivered must not store it twice.
   *
   * Called inside the ingest transaction, so the history and the snapshot it produced
   * either both land or neither does.
   */
  appendEvents(officeId: string, events: OfficeEvent[]): Promise<void>;
  /**
   * Events for one office in `[from, to]`, in the order they happened.
   *
   * No actor parameter, and there must not be one: replay is office-level (ADR 0003
   * decision 1, rule 6). Filtering by person here is what would turn this into the
   * thing the rule exists to prevent.
   */
  eventsBetween(officeId: string, from: string, to: string, limit?: number): Promise<OfficeEvent[]>;
  /**
   * Run `fn` against a store whose writes either all land or none do, with everything
   * under the same `key` — the office id — serialized against other writers.
   *
   * Ingest needs both halves. Atomicity: marking an event delivered and saving the
   * snapshot it produced are two writes, and a crash between them loses that event's
   * effect forever — the ledger says "applied" while the snapshot never saw it.
   * Serialization: the delivery loop reads a snapshot and writes it back, so two
   * deliveries for one office would overwrite each other. `KeyedQueue` already
   * prevents that inside one process; the lock is what extends it to two.
   *
   * Optional because it is a capability, not a requirement: `withOfficeTransaction`
   * runs `fn` inline against a store that does not offer one.
   *
   * The store handed to `fn` is the transactional view: use it, not the outer store.
   * Side effects that must not happen twice, publishing above all, belong *after* the
   * call, not inside it.
   */
  transaction?<T>(key: string, fn: (store: OfficeStore) => Promise<T>): Promise<T>;
}

/** `store.transaction` when the store has one, a plain call when it does not. */
export function withOfficeTransaction<T>(
  store: OfficeStore,
  key: string,
  fn: (store: OfficeStore) => Promise<T>,
): Promise<T> {
  return store.transaction ? store.transaction(key, fn) : fn(store);
}

/**
 * Process-local store. Everything is lost on restart — the default when no
 * `DATABASE_URL` is configured, and what the tests run against.
 */
export class InMemoryOfficeStore implements OfficeStore {
  readonly #offices = new Map<string, OfficeState>();
  readonly #delivered = new Set<string>();
  readonly #events = new Map<string, OfficeEvent[]>();

  /** Cap so a long-running process cannot grow the dedup set without bound. */
  constructor(private readonly maxDelivered = 10_000) {}

  async load(officeId: string): Promise<OfficeState | undefined> {
    return this.#offices.get(officeId);
  }

  async save(officeId: string, state: OfficeState): Promise<void> {
    this.#offices.set(officeId, state);
  }

  async markDelivered(eventId: string): Promise<boolean> {
    if (this.#delivered.has(eventId)) return false;
    if (this.#delivered.size >= this.maxDelivered) {
      // Oldest first: Set preserves insertion order.
      const oldest = this.#delivered.values().next();
      if (!oldest.done) this.#delivered.delete(oldest.value);
    }
    this.#delivered.add(eventId);
    return true;
  }

  async list(): Promise<string[]> {
    return [...this.#offices.keys()];
  }

  async appendEvents(officeId: string, events: OfficeEvent[]): Promise<void> {
    const log = this.#events.get(officeId) ?? [];
    for (const event of events) {
      if (log.some((e) => e.id === event.id)) continue;
      log.push(event);
    }
    log.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    this.#events.set(officeId, log);
  }

  async eventsBetween(officeId: string, from: string, to: string, limit = 10_000): Promise<OfficeEvent[]> {
    const lo = Date.parse(from);
    const hi = Date.parse(to);
    return (this.#events.get(officeId) ?? [])
      .filter((e) => {
        const t = Date.parse(e.at);
        return t >= lo && t <= hi;
      })
      .slice(0, limit);
  }

  /**
   * Copy on entry, restore on throw. There is no crash to survive in a process-local
   * map, but a half-applied delivery is just as wrong here as in Postgres, and having
   * both stores behave alike is what lets the ingest test run without a database.
   * The key is ignored: one process already serializes per office in `KeyedQueue`,
   * and a process-local store has no second writer to lock out.
   */
  async transaction<T>(_key: string, fn: (store: OfficeStore) => Promise<T>): Promise<T> {
    const offices = new Map(this.#offices);
    const delivered = new Set(this.#delivered);
    const events = new Map<string, OfficeEvent[]>([...this.#events].map(([id, log]) => [id, [...log]]));
    try {
      return await fn(this);
    } catch (err) {
      this.#offices.clear();
      for (const [id, state] of offices) this.#offices.set(id, state);
      this.#delivered.clear();
      for (const id of delivered) this.#delivered.add(id);
      this.#events.clear();
      for (const [id, log] of events) this.#events.set(id, log);
      throw err;
    }
  }
}
