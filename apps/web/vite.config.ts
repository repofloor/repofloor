import { defineConfig } from "vite";

/**
 * The web app is served from the same origin as `apps/api` (see README): the session
 * cookie is `HttpOnly` and `SameSite=Lax`, so a cross-site `fetch` would not carry it,
 * and the api sends no CORS headers. In production one reverse proxy puts the two
 * behind one hostname; in development this proxy does the same job.
 *
 * The socket is not proxied. In development it goes straight to `apps/realtime` on its
 * own port, which the browser still treats as same-site — cookies ignore ports — so
 * the session reaches the upgrade. In production `VITE_REALTIME_URL` is left empty and
 * the socket goes to the page's own origin, where the proxy routes upgrades on
 * `/office/...` to realtime and plain GETs on the same path to the api.
 */
const API = process.env["API_URL"] ?? "http://localhost:8787";

export default defineConfig({
  build: {
    outDir: "dist",
    target: "es2022",
  },
  server: {
    port: 5174,
    proxy: {
      "/auth": API,
      "/offices": API,
      "/office": API,
    },
  },
});
