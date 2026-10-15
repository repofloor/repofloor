/**
 * Entry point. Reads configuration from the environment and listens.
 *
 *   WEBHOOK_SECRET            required — the GitHub App webhook secret
 *   DATABASE_URL              Postgres connection string; without it the store is in-memory
 *   DATABASE_SSL              require | no-verify | disable (default: whatever the URL says)
 *   DATABASE_POOL_MAX         max pooled connections (default: pg's own default, 10)
 *   EVENT_RETENTION_DAYS      how long applied event ids are kept (default 7)
 *   ACCESS_TTL_MS             repo-read cache TTL (default 60000)
 *   GITHUB_API_URL            default https://api.github.com
 *   GITHUB_WEB_URL            default https://github.com (where the browser is sent)
 *   PORT                      default 8787
 *   HOST                      default 0.0.0.0
 *
 * Sign-in and the App identity are optional. Set them and `/auth/...` comes alive;
 * leave them unset and the service behaves exactly as before, with every caller
 * presenting its own token.
 *
 *   PUBLIC_BASE_URL           our own public origin, e.g. https://repofloor.example
 *   GITHUB_CLIENT_ID          the App's OAuth client id
 *   GITHUB_CLIENT_SECRET      the App's OAuth client secret
 *   SESSION_SECRET            signs the session cookie; rotating it signs everyone out
 *   SESSION_TTL_MS            session lifetime (default 12h)
 *   GITHUB_APP_ID             the App id, for minting installation tokens
 *   GITHUB_APP_PRIVATE_KEY    the App's private key, PEM (\n escapes accepted)
 *   GITHUB_APP_PRIVATE_KEY_PATH  … or a path to read it from
 *   GITHUB_APP_SLUG           the App's slug, for the /auth/install link
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createApp } from "./app.js";
import { GitHubRepoAccess } from "./access.js";
import { GitHubAppAuth } from "./app-auth.js";
import { createPool, migrate, type PoolOptions } from "./db.js";
import {
  InMemoryInstallationStore,
  PostgresInstallationStore,
  type InstallationStore,
} from "./installations.js";
import { GitHubOAuth } from "./oauth.js";
import { InMemorySessionStore } from "./session.js";
import { SignIn } from "./sign-in.js";
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
const apiUrl = process.env["GITHUB_API_URL"];

/** Hourly, so the applied-event ledger cannot grow forever. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let store: OfficeStore;
let installations: InstallationStore;
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
  installations = new PostgresInstallationStore(pool);

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
  installations = new InMemoryInstallationStore();
}

/**
 * The App identity: what lets the service act as the App rather than as a caller.
 * Optional, and only used for installations — never for authorizing a read.
 */
const appAuth = buildAppAuth();
const signIn = buildSignIn();

const ttl = Number(process.env["ACCESS_TTL_MS"]);
const app = createApp({
  webhookSecret: secret,
  store,
  installations,
  ...(signIn ? { signIn } : {}),
  access: new GitHubRepoAccess({
    ...(apiUrl ? { apiUrl } : {}),
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
  console.log(
    signIn
      ? `[api] sign-in enabled; the App's callback URL must be ${signIn.redirectUri}`
      : "[api] sign-in disabled (set PUBLIC_BASE_URL, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SESSION_SECRET)",
  );
  console.log(
    appAuth
      ? "[api] App identity configured: installation tokens can be minted"
      : "[api] no App identity (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY) — installations will not be recorded",
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

function buildAppAuth(): GitHubAppAuth | undefined {
  const appId = process.env["GITHUB_APP_ID"];
  const keyPath = process.env["GITHUB_APP_PRIVATE_KEY_PATH"];
  let privateKey = process.env["GITHUB_APP_PRIVATE_KEY"];

  if (!privateKey && keyPath) {
    try {
      privateKey = readFileSync(keyPath, "utf8");
    } catch (err) {
      console.error(`[api] could not read GITHUB_APP_PRIVATE_KEY_PATH (${keyPath}):`, err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }

  if (!appId && !privateKey) return undefined;
  if (!appId || !privateKey) {
    // Half-configured is a mistake, not a mode: say so instead of silently running
    // without an App identity.
    console.error("[api] GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (or _PATH) must be set together.");
    process.exit(1);
  }

  return new GitHubAppAuth({ appId, privateKey, ...(apiUrl ? { apiUrl } : {}) });
}

function buildSignIn(): SignIn | undefined {
  const clientId = process.env["GITHUB_CLIENT_ID"];
  const clientSecret = process.env["GITHUB_CLIENT_SECRET"];
  const cookieSecret = process.env["SESSION_SECRET"];
  const baseUrl = process.env["PUBLIC_BASE_URL"];

  if (!clientId && !clientSecret && !cookieSecret && !baseUrl) return undefined;

  const missing = [
    ["GITHUB_CLIENT_ID", clientId],
    ["GITHUB_CLIENT_SECRET", clientSecret],
    ["SESSION_SECRET", cookieSecret],
    ["PUBLIC_BASE_URL", baseUrl],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0 || !clientId || !clientSecret || !cookieSecret || !baseUrl) {
    console.error(`[api] sign-in is partly configured; missing: ${missing.join(", ")}. Set all four or none.`);
    process.exit(1);
  }

  if (!baseUrl.startsWith("https://") && !baseUrl.startsWith("http://localhost")) {
    // The session cookie can only be Secure over https, so anything else in production
    // would send it in clear.
    console.warn(`[api] PUBLIC_BASE_URL is not https (${baseUrl}): the session cookie will not be Secure.`);
  }

  const sessionTtl = Number(process.env["SESSION_TTL_MS"]);
  const sessions = new InMemorySessionStore(
    Number.isFinite(sessionTtl) && sessionTtl > 0 ? { ttlMs: sessionTtl } : {},
  );

  return new SignIn({
    oauth: new GitHubOAuth({
      clientId,
      clientSecret,
      ...(apiUrl ? { apiUrl } : {}),
      ...(process.env["GITHUB_WEB_URL"] ? { webUrl: process.env["GITHUB_WEB_URL"] } : {}),
    }),
    sessions,
    cookieSecret,
    baseUrl,
    ...(appAuth ? { appAuth } : {}),
    installations,
    ...(process.env["GITHUB_APP_SLUG"] ? { appSlug: process.env["GITHUB_APP_SLUG"] } : {}),
    ...(Number.isFinite(sessionTtl) && sessionTtl > 0 ? { cookieMaxAge: Math.floor(sessionTtl / 1000) } : {}),
  });
}
