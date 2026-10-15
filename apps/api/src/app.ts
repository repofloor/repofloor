/**
 * The HTTP surface of apps/api. Plain `node:http`, no framework: the whole service is
 * three routes, and every dependency it has is an interface declared in this package.
 *
 *   POST /webhook              GitHub App deliveries (signature required)
 *   GET  /office/:owner/:repo  the current snapshot, as OfficeState JSON
 *                              (a private office needs a GitHub token; see access.ts)
 *   GET  /healthz              liveness
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { PROTOCOL_VERSION } from "@repofloor/protocol";
import { decay, type GithubWebhook } from "@repofloor/reducer";
import { accessInvalidations, bearerToken, GitHubRepoAccess, type RepoAccess } from "./access.js";
import { ingestWebhook } from "./ingest.js";
import { NoopEventPublisher, type EventPublisher } from "./publisher.js";
import { InMemoryOfficeStore, type OfficeStore } from "./store.js";
import { SIGNATURE_HEADER, verifyWebhookSignature } from "./signature.js";

/** GitHub rejects deliveries above 25 MB; so do we, before buffering them. */
export const MAX_BODY_BYTES = 25 * 1024 * 1024;

export interface AppOptions {
  /** The GitHub App webhook secret. Required: without it no delivery can be trusted. */
  webhookSecret: string;
  store?: OfficeStore;
  publisher?: EventPublisher;
  /**
   * The repo-read check for `GET /office/...`. Defaults to asking GitHub with the
   * caller's own token — it needs no credentials of ours, so there is nothing to
   * configure and no way to run with reads left open.
   */
  access?: RepoAccess;
  /** Injected in tests so responses are deterministic. */
  now?: () => string;
}

export interface App {
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  store: OfficeStore;
  publisher: EventPublisher;
  access: RepoAccess;
}

export function createApp(options: AppOptions): App {
  const store = options.store ?? new InMemoryOfficeStore();
  const publisher = options.publisher ?? new NoopEventPublisher();
  const access = options.access ?? new GitHubRepoAccess();
  const now = options.now ?? (() => new Date().toISOString());

  if (!options.webhookSecret) throw new Error("createApp: webhookSecret is required");

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && (path === "/healthz" || path === "/")) {
      return json(res, 200, { ok: true, protocolVersion: PROTOCOL_VERSION });
    }

    if (path === "/webhook") {
      if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
      return handleWebhook(req, res);
    }

    const office = path.match(/^\/office\/([^/]+)\/([^/]+)$/);
    if (office) {
      if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
      return handleOffice(req, res, `${decodeURIComponent(office[1]!)}/${decodeURIComponent(office[2]!)}`);
    }

    return json(res, 404, { error: "not_found" });
  }

  async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (err) {
      const tooLarge = err instanceof Error && err.message === "body_too_large";
      return json(res, tooLarge ? 413 : 400, { error: tooLarge ? "body_too_large" : "bad_request" });
    }

    // Verify before parsing: the signature covers the raw bytes, and an unverified
    // payload is attacker-controlled input we should not spend work on.
    if (!verifyWebhookSignature(options.webhookSecret, body, req.headers[SIGNATURE_HEADER])) {
      return json(res, 401, { error: "invalid_signature" });
    }

    const event = header(req, "x-github-event");
    const deliveryId = header(req, "x-github-delivery");
    if (!event || !deliveryId) return json(res, 400, { error: "missing_github_headers" });

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return json(res, 400, { error: "invalid_json" });
    }
    if (typeof payload !== "object" || payload === null) {
      return json(res, 400, { error: "invalid_json" });
    }

    // Access changed? Drop the cached decisions now rather than waiting out the TTL.
    for (const officeId of accessInvalidations(event, payload as Record<string, unknown>)) {
      access.invalidateOffice(officeId);
    }

    const hook: GithubWebhook = { event, deliveryId, payload: payload as Record<string, unknown> };
    const result = await ingestWebhook(hook, { store, publisher });

    return json(res, 202, {
      ...(result.officeId ? { officeId: result.officeId } : {}),
      events: result.events.length,
      applied: result.applied.length,
    });
  }

  /**
   * A snapshot read. Public offices are open — the office is public exactly when a
   * signed delivery said so (`office.private === false`). Anything else, including an
   * office whose visibility we have not been told, needs a GitHub token that can see
   * the repository.
   *
   * A caller GitHub rejects gets `404 unknown_office`, the same answer as an office
   * that never had a delivery: whether a private repository exists is itself private,
   * and that is how GitHub's own API answers.
   */
  async function handleOffice(req: IncomingMessage, res: ServerResponse, officeId: string): Promise<void> {
    const state = await store.load(officeId);
    if (!state) return json(res, 404, { error: "unknown_office", officeId });

    if (state.office.private !== false) {
      const decision = await access.canRead(officeId, bearerToken(req.headers.authorization));
      if (!decision.allowed) {
        if (decision.reason === "unauthenticated") {
          res.setHeader("www-authenticate", 'Bearer realm="repofloor", error="invalid_request"');
          return json(res, 401, { error: "authentication_required", officeId });
        }
        if (decision.reason === "unavailable") {
          return json(res, 503, { error: "access_check_unavailable", officeId });
        }
        return json(res, 404, { error: "unknown_office", officeId });
      }
    }

    return json(res, 200, decay(state, now()));
  }

  return {
    store,
    publisher,
    access,
    handler(req, res) {
      route(req, res).catch((err: unknown) => {
        console.error("[api] unhandled", err);
        if (!res.headersSent) json(res, 500, { error: "internal_error" });
        else res.end();
      });
    },
  };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first && first.length > 0 ? first : undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
