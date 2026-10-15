/**
 * Entry point. Reads configuration from the environment and listens.
 *
 *   WEBHOOK_SECRET  required — the GitHub App webhook secret
 *   PORT            default 8787
 *   HOST            default 0.0.0.0
 */

import { createServer } from "node:http";
import { createApp } from "./app.js";

const secret = process.env["WEBHOOK_SECRET"];
if (!secret) {
  console.error("[api] WEBHOOK_SECRET is not set. Refusing to start: unsigned deliveries cannot be trusted.");
  process.exit(1);
}

const port = Number(process.env["PORT"] ?? 8787);
const host = process.env["HOST"] ?? "0.0.0.0";

const app = createApp({ webhookSecret: secret });
const server = createServer(app.handler);

server.listen(port, host, () => {
  console.log(`[api] listening on http://${host}:${port}`);
  console.log("[api] in-memory store: snapshots are lost on restart (see docs/adr/0001-full-mode-stack.md)");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[api] ${signal}, closing`);
    server.close(() => process.exit(0));
  });
}
