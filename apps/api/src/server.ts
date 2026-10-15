/**
 * Entry point. Reads configuration from the environment and listens.
 *
 *   WEBHOOK_SECRET        required — the GitHub App webhook secret
 *   DATABASE_URL          Postgres connection string; without it the store is in-memory
 *   DATABASE_SSL          require | no-verify | disable (default: whatever the URL says)
 *   DATABASE_POOL_MAX     max pooled connections (default: pg's own default, 10)
 *   EVENT_RETENTION_DAYS  how long applied event ids are kept (default 7)
 *   ACCESS_TTL_MS         repo-read cache TTL (default 60000)
 *   GITHUB_API_URL        default https://api.github.com
 *   PORT                  default 8787
 *   HOST                  default 0.0.0.0
 */

import { createServer } from "node:http";
import { createApp } from "./app.js";
import { GitHubRepoAccess } from "./access.js";
import { createPool, migrate, type PoolOptions } from "./db.js";
import { InMemoryOfficeStore, type OfficeStore } from "./store.js";
import { PostgresOfficeStore } from "./store-postgres.js";

const secret = process.env["WEBHOOK_SECRET"];
if (!secret) {
  console.error("[api] WEBHOOK_SECRET is not set. Refusing to start: unsigned deliveries cannot be trusted.");
  process.exit(1);
}

const port = Number(process.env["PORT"] ?? 8787);
const host = process.env["HOST"] ?? "0.0.0.0";
const databaseUrl = process.env["DATABASE_URL"];

/** Hourly, so the applied-event ledger cannot grow forever. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let store: OfficeStore;
let close: () => Promise<void> = async () => {};

if (databaseUrl) {
  const poolOptions: PoolOptions = {};
  const ssl = process.env["DATABASE_SSL"];
  if (ssl === "require" || ssl === "no-verify" || ssl === "disable") poolOptions.ssl = ssl;
  const max = Number(process.env["DATABASE_POOL_MAX"]);
  if (Number.isFinite(max) && max > 0) poolOptions.max = max;

  const pool = await createPool(databaseUrl, poolOptions);
  try {
    const applied = await migrate(pool);
    console.log(applied.length > 0 ? `[api] migrations applied: ${applied.join(", ")}` : "[api] schema up to date");
  } catch (err) {
    // Starting without the schema would mean dropping deliveries, so refuse instead.
    console.error("[api] could not reach DATABASE_URL or apply migrations:", err instanceof Error ? err.message : err);
    await pool.end().catch(() => {});
    process.exit(1);
  }

  const retention = Number(process.env["EVENT_RETENTION_DAYS"]);
  const pg = new PostgresOfficeStore(pool, {
    ...(Number.isFinite(retention) && retention > 0 ? { eventRetentionDays: retention } : {}),
  });
  store = pg;

  const prune = (): void => {
    pg.pruneDeliveries()
      .then((n) => n > 0 && console.log(`[api] pruned ${n} applied event ids`))
      .catch((err: unknown) => console.error("[api] prune failed", err));
  };
  prune();
  const timer = setInterval(prune, PRUNE_INTERVAL_MS);
  timer.unref();
  close = async () => {
    clearInterval(timer);
    await pool.end();
  };
} else {
  store = new InMemoryOfficeStore();
}

const ttl = Number(process.env["ACCESS_TTL_MS"]);
const app = createApp({
  webhookSecret: secret,
  store,
  access: new GitHubRepoAccess({
    ...(process.env["GITHUB_API_URL"] ? { apiUrl: process.env["GITHUB_API_URL"] } : {}),
    ...(Number.isFinite(ttl) && ttl > 0 ? { ttlMs: ttl } : {}),
  }),
});
const server = createServer(app.handler);

server.listen(port, host, () => {
  console.log(`[api] listening on http://${host}:${port}`);
  console.log(
    databaseUrl
      ? "[api] postgres store: snapshots and delivery dedup survive a restart"
      : "[api] in-memory store: snapshots are lost on restart (set DATABASE_URL for Postgres)",
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[api] ${signal}, closing`);
    server.close(() => {
      close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  });
}
