/**
 * Office storage.
 *
 * Two implementations live behind this interface: `InMemoryOfficeStore` here and
 * `PostgresOfficeStore` (ADR 0001) in `store-postgres.ts`. Nothing above this file
 * knows which one it is talking to.
 */

import type { OfficeState } from "@repofloor/protocol";

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
    try {
      return await fn(this);
    } catch (err) {
      this.#offices.clear();
      for (const [id, state] of offices) this.#offices.set(id, state);
      this.#delivered.clear();
      for (const id of delivered) this.#delivered.add(id);
      throw err;
    }
  }
}
