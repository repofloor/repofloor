/**
 * `OfficeStore` on plain Postgres (ADR 0001).
 *
 * Two tables, created by `migrations/001_offices.sql`:
 *   offices(office_id, snapshot jsonb, …)  — the current snapshot, one row per office
 *   applied_events(event_id, applied_at)   — the ledger that makes dedup durable
 *
 * `markDelivered` is an `insert … on conflict do nothing`: the primary key is the whole
 * dedup mechanism, so a webhook GitHub re-delivers after a restart still applies once.
 */

import type { OfficeState } from "@repofloor/protocol";
import type { Queryable } from "./db.js";
import type { OfficeStore } from "./store.js";

/** How long applied event ids are kept. GitHub does not re-deliver older than this. */
export const DEFAULT_EVENT_RETENTION_DAYS = 7;

export interface PostgresOfficeStoreOptions {
  eventRetentionDays?: number | undefined;
}

export class PostgresOfficeStore implements OfficeStore {
  readonly #db: Queryable;
  readonly #retentionDays: number;

  constructor(db: Queryable, options: PostgresOfficeStoreOptions = {}) {
    this.#db = db;
    this.#retentionDays = options.eventRetentionDays ?? DEFAULT_EVENT_RETENTION_DAYS;
  }

  async load(officeId: string): Promise<OfficeState | undefined> {
    const { rows } = await this.#db.query<{ snapshot: OfficeState }>(
      "select snapshot from offices where office_id = $1",
      [officeId],
    );
    return rows[0]?.snapshot;
  }

  async save(officeId: string, state: OfficeState): Promise<void> {
    await this.#db.query(
      `insert into offices (office_id, snapshot)
            values ($1, $2)
       on conflict (office_id)
       do update set snapshot = excluded.snapshot, updated_at = now()`,
      [officeId, JSON.stringify(state)],
    );
  }

  async markDelivered(eventId: string): Promise<boolean> {
    const { rows } = await this.#db.query<{ event_id: string }>(
      `insert into applied_events (event_id)
            values ($1)
       on conflict (event_id) do nothing
         returning event_id`,
      [eventId],
    );
    return rows.length === 1;
  }

  async list(): Promise<string[]> {
    const { rows } = await this.#db.query<{ office_id: string }>(
      "select office_id from offices order by office_id",
    );
    return rows.map((r) => r.office_id);
  }

  /**
   * The retention cut: drop event ids older than the window and return how many.
   * `make_interval` is core Postgres, so this stays portable.
   */
  async pruneDeliveries(): Promise<number> {
    const { rowCount } = await this.#db.query(
      "delete from applied_events where applied_at < now() - make_interval(days => $1::int)",
      [this.#retentionDays],
    );
    return rowCount ?? 0;
  }
}
