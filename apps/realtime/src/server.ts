/**
 * Entry point. Reads configuration from the environment and listens.
 *
 *   DATABASE_URL    required — the same Postgres apps/api writes to. Used for two
 *                   things: one dedicated LISTEN connection, and reading snapshots
 *                   when a notification was too large to carry its events.
 *   API_URL         required — where apps/api listens, e.g. http://api:8787. Every
 *                   socket is authorized by asking it, with the client's own
 *                   credentials forwarded (see src/access.ts).
 *   PORT            default 8788
 *   HOST            default 0.0.0.0
 *   DATABASE_SSL    require | no-verify | disable
 *   HEARTBEAT_MS    how often sockets are pinged (default 30000)
 *   PRESENCE_TTL_MS how long a silent viewer stays on the floor (default 90000)
 *   LOG_LEVEL       debug | info | warn | error | silent (default info)
 *
 * This service holds no credential of its own and makes no authorization decision:
 * it forwards the caller's and asks apps/api. There is nothing here to compromise
 * into a wider read than the caller already had.
 */

import { createServer } from "node:http";
import {
  createLogger,
  createPool,
  errorFields,
  levelFromEnv,
  PostgresEventSubscriber,
  PostgresOfficeStore,
  type ListenConnection,
  type PoolOptions,
} from "@repofloor/api";
import { ApiConnectAuthorizer } from "./access.js";
import { OfficeHub } from "./hub.js";
import { createSocketServer } from "./socket.js";

const log = createLogger({ level: levelFromEnv(process.env["LOG_LEVEL"]), base: { service: "realtime" } });

const databaseUrl = process.env["DATABASE_URL"];
const apiUrl = process.env["API_URL"];

if (!databaseUrl) {
  log.error("DATABASE_URL is not set; realtime listens on the database apps/api writes to");
  process.exit(1);
}
if (!apiUrl) {
  log.error("API_URL is not set; every socket is authorized by asking apps/api");
  process.exit(1);
}

const port = Number(process.env["PORT"] ?? 8788);
const host = process.env["HOST"] ?? "0.0.0.0";

const poolOptions: PoolOptions = {};
const ssl = process.env["DATABASE_SSL"];
if (ssl === "require" || ssl === "no-verify" || ssl === "disable") poolOptions.ssl = ssl;

const pool = await createPool(databaseUrl, poolOptions);
const snapshots = new PostgresOfficeStore(pool);

const presenceTtl = Number(process.env["PRESENCE_TTL_MS"]);
const hub = new OfficeHub({
  snapshots,
  logger: log,
  ...(Number.isFinite(presenceTtl) && presenceTtl > 0 ? { presence: { ttlMs: presenceTtl } } : {}),
});

/**
 * The listener gets its own connection, outside the pool: `LISTEN` is a property of a
 * session, and a pooled connection handed back would stop listening.
 */
const subscriber = new PostgresEventSubscriber({
  logger: log,
  connect: async () => {
    const client = await pool.connect();
    // Never released: this one is ours for the life of the process.
    return client as unknown as ListenConnection;
  },
});

subscriber.onNotification((notification) => {
  void hub.deliver(notification.officeId, notification.events).catch((err: unknown) => {
    log.error("delivery failed", { officeId: notification.officeId, ...errorFields(err) });
  });
});

// The listener reconnected and cannot know what it missed, so every live channel
// goes back to the snapshot rather than guessing.
subscriber.onResync(() => {
  log.warn("listener reconnected; resyncing every live office");
  void hub.resyncAll().catch((err: unknown) => log.error("resync failed", errorFields(err)));
});

await subscriber.start();

const server = createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
    const body = JSON.stringify({ ok: true, offices: hub.officeCount });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return;
  }
  // Everything else here is a WebSocket URL reached over plain HTTP.
  res.writeHead(426, { "content-type": "application/json; charset=utf-8", upgrade: "websocket" });
  res.end(JSON.stringify({ error: "upgrade_required" }));
});

const heartbeat = Number(process.env["HEARTBEAT_MS"]);
const sockets = createSocketServer({
  server,
  hub,
  authorizer: new ApiConnectAuthorizer({ apiUrl }),
  logger: log,
  ...(Number.isFinite(heartbeat) && heartbeat > 0 ? { heartbeatMs: heartbeat } : {}),
});

server.listen(port, host, () => {
  log.info("listening", { url: `http://${host}:${port}`, apiUrl, socketPath: "/office/:owner/:repo" });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info("shutting down", { signal });
    void (async () => {
      await sockets.close();
      await subscriber.stop();
      server.close(() => {
        pool.end().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      });
    })();
  });
}
