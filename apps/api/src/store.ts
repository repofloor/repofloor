/**
 * Office storage.
 *
 * TODO(full-mode): replace `InMemoryOfficeStore` with Postgres per ADR 0001
 * (`docs/adr/0001-full-mode-stack.md`). The interface below is the whole seam:
 * `load`/`save` become a row per office (snapshot as JSONB plus the event log), and
 * `markDelivered` becomes an insert on a unique delivery/event id, which is how
 * re-delivered webhooks stay idempotent across restarts. Nothing above this file
 * knows which implementation it is talking to.
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
}

/** Process-local store. Everything is lost on restart; fine until Postgres lands. */
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
}
