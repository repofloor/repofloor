/**
 * Installations: reading GitHub's payload, the in-memory store, and the SQL the
 * Postgres store sends (against a recording fake, so this needs no database — the
 * real-database coverage lives in tests/store-postgres.test.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryInstallationStore,
  PostgresInstallationStore,
  installationFromPayload,
  type Installation,
} from "../src/installations.ts";
import type { QueryResult, Queryable } from "../src/db.ts";

const installation = (over: Partial<Installation> = {}): Installation => ({
  installationId: 42,
  accountLogin: "repofloor",
  accountId: 99,
  accountType: "Organization",
  repositorySelection: "selected",
  suspended: false,
  ...over,
});

/** The `installation` object as GitHub sends it. */
const payload = {
  id: 42,
  account: { login: "repofloor", id: 99, type: "Organization" },
  repository_selection: "selected",
  suspended_at: null,
};

class FakeDb implements Queryable {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  rows: object[] = [];

  async query<R extends object>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
    this.calls.push({ sql, params });
    return { rows: this.rows as R[], rowCount: this.rows.length };
  }
}

test("installationFromPayload reads what GitHub sends", () => {
  assert.deepEqual(installationFromPayload(payload), installation());

  assert.deepEqual(
    installationFromPayload({ ...payload, suspended_at: "2026-10-01T00:00:00Z" }),
    installation({ suspended: true }),
  );

  assert.deepEqual(
    installationFromPayload({ id: 7, account: { login: "aliosmanmho" } }),
    { installationId: 7, accountLogin: "aliosmanmho", suspended: false },
    "the optional fields really are optional",
  );
});

test("installationFromPayload refuses anything that is not an installation", () => {
  for (const bad of [
    undefined,
    null,
    "installation",
    {},
    { id: 42 }, // no account
    { id: 0, account: { login: "x" } },
    { id: -1, account: { login: "x" } },
    { id: "not-a-number", account: { login: "x" } },
    { id: 42, account: { login: "" } },
    { id: 42, account: {} },
  ]) {
    assert.equal(installationFromPayload(bad), undefined, `${JSON.stringify(bad)} is not an installation`);
  }
});

test("the in-memory store upserts, finds and removes", async () => {
  const store = new InMemoryInstallationStore();
  await store.upsert(installation());

  assert.deepEqual(await store.get(42), installation());
  assert.deepEqual(await store.byAccount("RepoFloor"), installation(), "GitHub logins are case-insensitive");
  assert.equal(await store.byAccount("someone-else"), undefined);

  await store.upsert(installation({ suspended: true }));
  assert.equal((await store.get(42))?.suspended, true, "the newest answer wins");
  assert.deepEqual(await store.list(), [installation({ suspended: true })]);

  await store.remove(42);
  assert.equal(await store.get(42), undefined);
  assert.deepEqual(await store.list(), []);
});

test("the Postgres store upserts on the installation id", async () => {
  const db = new FakeDb();
  await new PostgresInstallationStore(db).upsert(installation());

  const call = db.calls[0]!;
  assert.match(call.sql, /insert into installations/);
  assert.match(call.sql, /on conflict \(installation_id\)/, "re-installing updates the row, it does not fail");
  assert.match(call.sql, /updated_at\s+= now\(\)/);
  assert.deepEqual(call.params, [42, "repofloor", 99, "Organization", "selected", false]);
  assert.ok(!/token/i.test(call.sql), "no credential is ever written to the database");
});

test("the Postgres store reads bigints back as numbers", async () => {
  const db = new FakeDb();
  const store = new PostgresInstallationStore(db);

  // `pg` hands bigint columns back as strings, which is why the SQL casts them.
  db.rows = [
    {
      installation_id: "42",
      account_login: "repofloor",
      account_id: "99",
      account_type: "Organization",
      repository_selection: "selected",
      suspended: false,
    },
  ];
  assert.deepEqual(await store.get(42), installation());
  assert.match(db.calls[0]!.sql, /installation_id::text/);
  assert.deepEqual(db.calls[0]!.params, [42]);

  // Nulls become absent fields rather than nulls.
  db.rows = [
    {
      installation_id: "7",
      account_login: "aliosmanmho",
      account_id: null,
      account_type: null,
      repository_selection: null,
      suspended: true,
    },
  ];
  assert.deepEqual(await store.get(7), {
    installationId: 7,
    accountLogin: "aliosmanmho",
    suspended: true,
  });
});

test("the Postgres store looks accounts up case-insensitively, and deletes by id", async () => {
  const db = new FakeDb();
  const store = new PostgresInstallationStore(db);

  await store.byAccount("RepoFloor");
  assert.match(db.calls[0]!.sql, /lower\(account_login\) = lower\(\$1\)/);
  assert.deepEqual(db.calls[0]!.params, ["RepoFloor"]);

  await store.remove(42);
  assert.match(db.calls[1]!.sql, /delete from installations where installation_id = \$1/);
  assert.deepEqual(db.calls[1]!.params, [42]);

  db.rows = [];
  assert.deepEqual(await store.list(), []);
  assert.match(db.calls[2]!.sql, /order by installation_id/);
});
