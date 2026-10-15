/**
 * The HTTP surface of apps/api. Plain `node:http`, no framework: every dependency it
 * has is an interface declared in this package.
 *
 *   POST /webhook                GitHub App deliveries (signature required)
 *   GET  /office/:owner/:repo    the current snapshot, as OfficeState JSON
 *                                (a private office needs a GitHub token or a session)
 *   GET  /auth/github            start "Sign in with GitHub"       ─┐
 *   GET  /auth/github/callback   finish it, open a session          │ only when sign-in
 *   GET  /auth/me                who is signed in                   │ is configured
 *   POST /auth/logout            end the session                    │ (see sign-in.ts)
 *   GET  /auth/install           send the owner to install the App  │
 *   GET  /auth/install/callback  the App's Setup URL               ─┘
 *   GET  /healthz                liveness
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { PROTOCOL_VERSION } from "@repofloor/protocol";
import { decay, type GithubWebhook } from "@repofloor/reducer";
import { accessInvalidations, bearerToken, GitHubRepoAccess, type RepoAccess } from "./access.js";
import { header, json, MAX_BODY_BYTES, readBody } from "./http.js";
import { ingestWebhook } from "./ingest.js";
import { installationFromPayload, type InstallationStore } from "./installations.js";
import { NoopEventPublisher, type EventPublisher } from "./publisher.js";
import type { SignIn } from "./sign-in.js";
import { InMemoryOfficeStore, type OfficeStore } from "./store.js";
import { SIGNATURE_HEADER, verifyWebhookSignature } from "./signature.js";

export { MAX_BODY_BYTES };

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
  /**
   * "Sign in with GitHub". Optional: without it the service still works exactly as it
   * did, with the caller presenting a token on every request, and `/auth/...` answers
   * `501`. It is never a second ACL — see sign-in.ts.
   */
  signIn?: SignIn | undefined;
  /**
   * Where `installation` deliveries are recorded. Not an ACL either (CLAUDE.md rule 6):
   * it is what lets the service later act as the App.
   */
  installations?: InstallationStore | undefined;
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
  const signIn = options.signIn;
  const installations = options.installations;
  const now = options.now ?? (() => new Date().toISOString());

  if (!options.webhookSecret) throw new Error("createApp: webhookSecret is required");

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && (path === "/healthz" || path === "/")) {
      return json(res, 200, { ok: true, protocolVersion: PROTOCOL_VERSION, signIn: signIn !== undefined });
    }

    if (path === "/webhook") {
      if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
      return handleWebhook(req, res);
    }

    if (path.startsWith("/auth/")) return handleAuth(req, res, url, path);

    const office = path.match(/^\/office\/([^/]+)\/([^/]+)$/);
    if (office) {
      if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
      return handleOffice(req, res, `${decodeURIComponent(office[1]!)}/${decodeURIComponent(office[2]!)}`);
    }

    return json(res, 404, { error: "not_found" });
  }

  /**
   * The sign-in routes. They exist as soon as the path matches, so an operator who has
   * not configured a client id gets `501 sign_in_not_configured` rather than a `404`
   * that looks like a typo.
   */
  async function handleAuth(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    path: string,
  ): Promise<void> {
    if (!signIn) return json(res, 501, { error: "sign_in_not_configured" });

    const get = req.method === "GET";
    switch (path) {
      case "/auth/github":
        if (!get) return json(res, 405, { error: "method_not_allowed" });
        return signIn.begin(req, res, url);
      case "/auth/github/callback":
        if (!get) return json(res, 405, { error: "method_not_allowed" });
        return signIn.callback(req, res, url);
      case "/auth/me":
        if (!get) return json(res, 405, { error: "method_not_allowed" });
        return signIn.me(req, res);
      case "/auth/logout":
        // POST only: a logout a third-party page can trigger with an image tag is a
        // nuisance, not a vulnerability, but it is free to avoid.
        if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
        return signIn.logout(req, res);
      case "/auth/install":
        if (!get) return json(res, 405, { error: "method_not_allowed" });
        return signIn.install(req, res);
      case "/auth/install/callback":
        if (!get) return json(res, 405, { error: "method_not_allowed" });
        return signIn.installCallback(req, res, url);
      default:
        return json(res, 404, { error: "not_found" });
    }
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

    // An installation came or went. This is the signed, authoritative path — the setup
    // callback is only a convenience for the owner's own browser.
    if (event === "installation") await recordInstallation(payload as Record<string, unknown>);

    const hook: GithubWebhook = { event, deliveryId, payload: payload as Record<string, unknown> };
    const result = await ingestWebhook(hook, { store, publisher });

    return json(res, 202, {
      ...(result.officeId ? { officeId: result.officeId } : {}),
      events: result.events.length,
      applied: result.applied.length,
    });
  }

  /**
   * `installation` deliveries: `created`, `deleted`, `suspend`, `unsuspend`,
   * `new_permissions_accepted`. The payload carries the whole installation object, so
   * nothing has to be fetched back.
   */
  async function recordInstallation(payload: Record<string, unknown>): Promise<void> {
    if (!installations) return;
    const installation = installationFromPayload(payload["installation"]);
    if (!installation) return;

    try {
      if (payload["action"] === "deleted") await installations.remove(installation.installationId);
      else await installations.upsert(installation);
    } catch (err) {
      // A delivery must still be acknowledged: GitHub retries, and the setup callback
      // and the next delivery are both another chance to record this.
      console.error("[api] could not record installation", installation.installationId, err);
    }
  }

  /**
   * A snapshot read. Public offices are open — the office is public exactly when a
   * signed delivery said so (`office.private === false`). Anything else, including an
   * office whose visibility we have not been told, needs a GitHub token that can see
   * the repository.
   *
   * The token comes from one of two places, and both end in the same check: an explicit
   * `Authorization: Bearer <token>` (a script, `gh auth token`, another service), or the
   * session cookie of a signed-in browser, whose token the browser never sees. The
   * header wins when both are present, so a deliberate token is never silently ignored.
   *
   * A caller GitHub rejects gets `404 unknown_office`, the same answer as an office
   * that never had a delivery: whether a private repository exists is itself private,
   * and that is how GitHub's own API answers.
   */
  async function handleOffice(req: IncomingMessage, res: ServerResponse, officeId: string): Promise<void> {
    const state = await store.load(officeId);
    if (!state) return json(res, 404, { error: "unknown_office", officeId });

    if (state.office.private !== false) {
      const token = bearerToken(req.headers.authorization) ?? (await signIn?.sessionToken(req));
      const decision = await access.canRead(officeId, token);
      if (!decision.allowed) {
        if (decision.reason === "unauthenticated") {
          res.setHeader("www-authenticate", 'Bearer realm="repofloor", error="invalid_request"');
          return json(res, 401, {
            error: "authentication_required",
            officeId,
            ...(signIn ? { signIn: "/auth/github" } : {}),
          });
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
