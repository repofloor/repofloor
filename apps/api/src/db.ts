/**
 * The database seam: a tiny `Queryable` interface, a `pg` pool behind it, and a
 * migration runner that applies numbered `.sql` files.
 *
 * Why so little: ADR 0001 requires the database to stay replaceable — plain SQL, no
 * ORM, no extension. `Queryable` is the only thing the store talks to, which also lets
 * the store be unit-tested without a server.
 */

import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolConfig } from "pg";

export interface QueryResult<R> {
  rows: R[];
  /** `pg` reports null for statements that return no row count. */
  rowCount: number | null;
}

/** The shape of `pg.Pool` and `pg.Client` that this package uses. */
export interface Queryable {
  query<R extends object = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
}

/** A pool hands out single connections; migrations need one, see `migrate`. */
export interface PoolLike extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

export interface PoolOptions {
  /** `require` verifies the server certificate, `no-verify` does not, `disable` is plain TCP. */
  ssl?: "require" | "no-verify" | "disable" | undefined;
  max?: number | undefined;
}

/**
 * `pg` is imported lazily so running without `DATABASE_URL` never loads it.
 * The returned pool is also a `Queryable`.
 */
export async function createPool(connectionString: string, options: PoolOptions = {}): Promise<Pool & Queryable> {
  const { Pool: PgPool } = await import("pg");
  const config: PoolConfig = { connectionString };
  if (options.max !== undefined) config.max = options.max;
  if (options.ssl === "require") config.ssl = { rejectUnauthorized: true };
  if (options.ssl === "no-verify") config.ssl = { rejectUnauthorized: false };
  if (options.ssl === "disable") config.ssl = false;
  return new PgPool(config) as Pool & Queryable;
}

/** Directory holding the numbered migrations, resolved relative to this file. */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export interface Migration {
  /** Leading number, zero-padded as written: `001`. */
  version: string;
  name: string;
  sql: string;
}

/** Read `NNN_name.sql` files in version order. Anything else in the directory is ignored. */
export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const version = file.slice(0, file.indexOf("_"));
    migrations.push({ version, name: file, sql: await readFile(join(dir, file), "utf8") });
  }
  return migrations;
}

/**
 * Apply every migration this database has not seen yet, each in its own transaction,
 * and return the names applied.
 *
 * Concurrent starts are serialized with a session advisory lock (core Postgres, not an
 * extension), so two api processes booting together cannot apply the same file twice.
 * Given a pool, one connection is checked out for the whole run: `begin`/`commit` and
 * the advisory lock are only meaningful on a single session.
 */
export async function migrate(db: Queryable | PoolLike, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  if (isPool(db)) {
    const client = await db.connect();
    try {
      return await runMigrations(client, dir);
    } finally {
      client.release();
    }
  }
  return runMigrations(db, dir);
}

function isPool(db: Queryable | PoolLike): db is PoolLike {
  return typeof (db as PoolLike).connect === "function";
}

async function runMigrations(db: Queryable, dir: string): Promise<string[]> {
  const migrations = await loadMigrations(dir);
  const lockKey = lockKeyFor("repofloor.migrations");

  await db.query(`create table if not exists schema_migrations (
    version    text primary key,
    name       text not null,
    applied_at timestamptz not null default now()
  )`);

  await db.query("select pg_advisory_lock($1)", [lockKey]);
  try {
    const { rows } = await db.query<{ version: string }>("select version from schema_migrations");
    const applied = new Set(rows.map((r) => r.version));
    const ran: string[] = [];

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      await db.query("begin");
      try {
        await db.query(migration.sql);
        await db.query("insert into schema_migrations (version, name) values ($1, $2)", [
          migration.version,
          migration.name,
        ]);
        await db.query("commit");
      } catch (err) {
        await db.query("rollback");
        throw err;
      }
      ran.push(migration.name);
    }
    return ran;
  } finally {
    await db.query("select pg_advisory_unlock($1)", [lockKey]);
  }
}

/** A stable 64-bit advisory lock key from a name. */
function lockKeyFor(name: string): string {
  const digest = createHash("sha256").update(name).digest();
  // Signed 64-bit: take 63 bits so the value always fits in bigint.
  return (BigInt(`0x${digest.subarray(0, 8).toString("hex")}`) >> 1n).toString();
}
