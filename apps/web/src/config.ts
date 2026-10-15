/**
 * Build-time configuration, which is to say: almost none.
 *
 * Both values are empty in a normal deployment, because the api, the socket and these
 * files are behind one hostname (see README). They exist for anyone proxying under a
 * path prefix, and for the development server, where the socket cannot be proxied:
 * Vite would have to route an upgrade and a GET on the same path to different places,
 * which is the one thing the production proxy does and a dev config should not need to.
 *
 * In development the socket therefore goes straight to `apps/realtime` on its own
 * port. The browser still treats that as same-site, because cookies ignore ports, so
 * the session cookie set through the proxy reaches the upgrade.
 */

/// <reference types="vite/client" />

const env = import.meta.env as Record<string, string | undefined> & { DEV?: boolean };

const DEV_REALTIME_URL = "ws://localhost:8788";

export const API_BASE = env["VITE_API_BASE"] ?? "";
export const REALTIME_URL = env["VITE_REALTIME_URL"] ?? (env.DEV ? DEV_REALTIME_URL : "");
