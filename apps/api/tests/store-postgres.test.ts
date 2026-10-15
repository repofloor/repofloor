/**
 * Two layers of coverage:
 *
 * - Unit tests against a recording fake `Queryable`, which assert the SQL the store
 *   sends (upsert, `on conflict do nothing` dedup, the retention cut). They run
 *   everywhere, including CI, with no database.
 * - One integration test that runs the real migrations and the real store, skipped
 *   unless `DATABASE_URL` points at a throwaway Postgres.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyOfficeState, type Building, type Office, type OfficeState } from "@repofloor/protocol";
import { createPool, loadMigrations, migrate, type QueryResult, type Queryable } from "../src/db.ts";
import { PostgresOfficeStore } from "../src/store-postgres.ts";
import { PostgresInstallationStore } from "../src/installations.ts";

const building: Building = { id: "repofloor", name: "repofloor", kind: "organization" };
const office: Office = { id: "repofloor/repofloor", buildingId: "repofloor", name: "repofloor", private: false };
const state = (): OfficeState => emptyOfficeState(building, office, "full");

interface Call {
  sql: string;
  params: unknown[];
}

/** A `Queryable` that records statements and answers from a queue of canned results. */
class FakeDb implements Queryable {
  readonly calls: Call[] = [];
  readonly #answers: Array<{ rows: object[]; rowCount: number | null }> = [];

  answer(rows: object[], rowCount: number | null = rows.length): this {
    this.#answers.push({ rows, rowCount });
    return this;
  }

  async query<R extends object>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
    this.calls.push({ sql, params });
    const next = this.#answers.shift() ?? { rows: [], rowCount: 0 };
    return { rows: next.rows as R[], rowCount: next.rowCount };
  }

  /** Whitespace-insensitive view of one statement, so SQL formatting cannot break a test. */
  sqlOf(index: number): string {
    return (this.calls[index]?.sql ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  }
}

test("load returns the stored snapshot, or undefined for an unknown office", async () => {
  const db = new FakeDb().answer([{ snapshot: state() }]).answer([]);
  const store = new PostgresOfficeStore(db);

  const loaded = await store.load("repofloor/repofloor");
  assert.equal(loaded?.office.id, "repofloor/repofloor");
  assert.equal(db.sqlOf(0), "select snapshot from offices where office_id = $1");
  assert.deepEqual(db.calls[0]?.params, ["repofloor/repofloor"]);

  assert.equal(await store.load("nobody/nothing"), undefined);
});

test("save upserts the snapshot as JSON", async () => {
  const db = new FakeDb();
  await new PostgresOfficeStore(db).save("repofloor/repofloor", state());

  const sql = db.sqlOf(0);
  assert.match(sql, /insert into offices \(office_id, snapshot\)/);
  assert.match(sql, /on conflict \(office_id\) do update set snapshot = excluded\.snapshot/);
  assert.equal(db.calls[0]?.params[0], "repofloor/repofloor");
  assert.equal(typeof db.calls[0]?.params[1], "string", "jsonb is sent as a JSON string");
  assert.equal(JSON.parse(db.calls[0]?.params[1] as string).office.id, "repofloor/repofloor");
});

test("markDelivered is true only for an event id the table did not already hold", async () => {
  // The first insert returns its row; the re-delivery conflicts and returns nothing.
  const db = new FakeDb().answer([{ event_id: "push:delivery-1" }]).answer([]);
  const store = new PostgresOfficeStore(db);

  assert.equal(await store.markDelivered("push:delivery-1"), true);
  assert.equal(await store.markDelivered("push:delivery-1"), false);

  const sql = db.sqlOf(0);
  assert.match(sql, /insert into applied_events \(event_id\)/);
  assert.match(sql, /on conflict \(event_id\) do nothing/);
  assert.match(sql, /returning event_id/);
});

test("list returns office ids in a stable order", async () => {
  const db = new FakeDb().answer([{ office_id: "a/one" }, { office_id: "b/two" }]);
  assert.deepEqual(await new PostgresOfficeStore(db).list(), ["a/one", "b/two"]);
  assert.match(db.sqlOf(0), /order by office_id/);
});

test("pruneDeliveries cuts ids older than the retention window", async () => {
  const db = new FakeDb().answer([], 12);
  const store = new PostgresOfficeStore(db, { eventRetentionDays: 3 });

  assert.equal(await store.pruneDeliveries(), 12);
  assert.match(db.sqlOf(0), /delete from applied_events where applied_at < now\(\) - make_interval/);
  assert.deepEqual(db.calls[0]?.params, [3]);
});

test("migrate applies each pending file once, in version order, inside a transaction", async () => {
  const db = new FakeDb()
    .answer([]) // create table schema_migrations
    .answer([]) // pg_advisory_lock
    .answer([]); // select version from schema_migrations — nothing applied yet
  const applied = await migrate(db);

  const files = (await loadMigrations()).map((m) => m.name);
  assert.ok(files.length > 0, "there is at least one migration on disk");
  assert.deepEqual(applied, files);

  const statements = db.calls.map((c) => c.sql.replace(/\s+/g, " ").trim().toLowerCase());
  assert.match(statements[0] ?? "", /create table if not exists schema_migrations/);
  assert.match(statements[1] ?? "", /pg_advisory_lock/);
  assert.ok(statements.includes("begin") && statements.includes("commit"));
  assert.match(statements.at(-1) ?? "", /pg_advisory_unlock/);
  assert.equal(statements.filter((s) => s.startsWith("insert into schema_migrations")).length, files.length);
});

test("migrate skips files the database has already recorded", async () => {
  const files = await loadMigrations();
  const db = new FakeDb()
    .answer([])
    .answer([])
    .answer(files.map((m) => ({ version: m.version })));

  assert.deepEqual(await migrate(db), []);
  assert.ok(!db.calls.some((c) => c.sql.trim().toLowerCase() === "begin"), "nothing was applied");
});

test(
  "against a real Postgres: migrations, snapshot round-trip, durable dedup, retention, installations",
  { skip: process.env["DATABASE_URL"] ? false : "set DATABASE_URL to a throwaway database to run this" },
  async () => {
    const pool = await createPool(process.env["DATABASE_URL"]!);
    try {
      const officeId = `repofloor/it-${Date.now()}`;
      const eventId = `push:it-${Date.now()}`;
      assert.ok(Array.isArray(await migrate(pool)));
      assert.deepEqual(await migrate(pool), [], "a second run applies nothing");

      const store = new PostgresOfficeStore(pool, { eventRetentionDays: 1 });
      assert.equal(await store.load(officeId), undefined);

      const snapshot = { ...state(), office: { ...office, id: officeId } };
      await store.save(officeId, snapshot);
      assert.equal((await store.load(officeId))?.office.id, officeId);

      await store.save(officeId, snapshot);
      assert.equal((await store.list()).filter((id) => id === officeId).length, 1, "save replaces, never duplicates");

      assert.equal(await store.markDelivered(eventId), true);
      assert.equal(await store.markDelivered(eventId), false, "dedup is a primary key, so it survives a restart");

      // A row older than the window is cut; the fresh one stays.
      const staleId = `${eventId}:stale`;
      await pool.query(
        "insert into applied_events (event_id, applied_at) values ($1, now() - make_interval(days => 30))",
        [staleId],
      );
      assert.ok((await store.pruneDeliveries()) >= 1);
      const { rows } = await pool.query<{ event_id: string }>(
        "select event_id from applied_events where event_id = any($1::text[])",
        [[eventId, staleId]],
      );
      assert.deepEqual(
        rows.map((r) => r.event_id),
        [eventId],
      );

      // The installations table from migration 002, through its own store.
      const installations = new PostgresInstallationStore(pool);
      const installationId = Number(`9${String(Date.now()).slice(-8)}`);
      await installations.upsert({
        installationId,
        accountLogin: `it-${installationId}`,
        accountId: 99,
        accountType: "Organization",
        repositorySelection: "selected",
        suspended: false,
      });
      assert.equal((await installations.get(installationId))?.accountId, 99, "bigints come back as numbers");
      assert.equal(
        (await installations.byAccount(`IT-${installationId}`))?.installationId,
        installationId,
        "looked up case-insensitively",
      );

      await installations.upsert({
        installationId,
        accountLogin: `it-${installationId}`,
        accountId: 99,
        suspended: true,
      });
      const suspended = await installations.get(installationId);
      assert.equal(suspended?.suspended, true, "re-installing updates the row");
      assert.equal(suspended?.accountType, undefined, "and nulls read back as absent, not null");

      await installations.remove(installationId);
      assert.equal(await installations.get(installationId), undefined);

      await pool.query("delete from applied_events where event_id = $1", [eventId]);
      await pool.query("delete from offices where office_id = $1", [officeId]);
    } finally {
      await pool.end();
    }
  },
);
