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

import type { OfficeEvent, OfficeState } from "@repofloor/protocol";
import type { PoolLike, Queryable } from "./db.js";
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

  /**
   * One connection, `begin` … `commit`, and a store bound to it.
   *
   * `pg_advisory_xact_lock` on the key makes writers for one office queue up across
   * processes, and it is transaction-scoped, so a crashed connection releases it with
   * no cleanup of ours. It covers an office's very first delivery too, which a row
   * lock could not: there is no row yet to lock.
   *
   * Needs a pool to check a connection out of: given a bare `Queryable` (a single
   * client, or a test double) there is nothing to isolate, so `fn` runs inline —
   * which is also what makes a nested call harmless.
   */
  async transaction<T>(key: string, fn: (store: OfficeStore) => Promise<T>): Promise<T> {
    const pool = this.#db as Partial<PoolLike>;
    if (typeof pool.connect !== "function") return fn(this);

    const client = await pool.connect();
    try {
      await client.query("begin");
      try {
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
        const result = await fn(new PostgresOfficeStore(client, { eventRetentionDays: this.#retentionDays }));
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
    } finally {
      client.release();
    }
  }

  /**
   * Insert, skipping anything already stored. The conflict target is the event id, so
   * a backfill walking into commits a webhook already delivered is a no-op rather than
   * a duplicate or an error.
   *
   * One statement over unnested arrays rather than a loop: a backfill arrives in
   * batches of hundreds, and a round trip each would dominate the time.
   */
  async appendEvents(officeId: string, events: OfficeEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.#db.query(
      `insert into office_events (event_id, office_id, at, body)
            select * from unnest($1::text[], $2::text[], $3::timestamptz[], $4::jsonb[])
       on conflict (event_id) do nothing`,
      [
        events.map((e) => e.id),
        events.map(() => officeId),
        events.map((e) => e.at),
        events.map((e) => JSON.stringify(e)),
      ],
    );
  }

  /** Office-level by construction: there is no actor parameter to pass (ADR 0003). */
  async eventsBetween(officeId: string, from: string, to: string, limit = 10_000): Promise<OfficeEvent[]> {
    const { rows } = await this.#db.query<{ body: OfficeEvent }>(
      `select body from office_events
        where office_id = $1 and at >= $2 and at <= $3
        order by at asc, event_id asc
        limit $4`,
      [officeId, from, to, limit],
    );
    return rows.map((r) => r.body);
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
