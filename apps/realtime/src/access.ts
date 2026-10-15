/**
 * May this socket connect, and who is on the other end?
 *
 * Both answers come from `apps/api`, over HTTP, by forwarding the client's own
 * credentials. That is not laziness — it is the strongest form of "no second ACL"
 * (CLAUDE.md rule 6) available to us:
 *
 * - `GET /office/:owner/:repo` *is* the check phase 2A lifted into
 *   `authorizeOfficeRead`. Calling it means realtime runs that code, not a copy of it
 *   that can drift.
 * - A browser cannot set an `Authorization` header on a WebSocket, so the session
 *   cookie is the only identity it has. Sessions live in the api's memory on purpose
 *   (no credential is ever written to the database — ADR 0001), so realtime cannot
 *   resolve a cookie by itself and must not try. Forwarding it keeps the token inside
 *   the process that owns it.
 * - The 200 carries the current snapshot, which is the first frame we owe the client
 *   anyway. One round trip does authorization and the initial state together.
 *
 * The cost is a dependency on the api being reachable. A socket that cannot be
 * authorized is refused, never admitted — failing open here would be a hole.
 */

import type { IncomingMessage } from "node:http";
import type { OfficeState } from "@repofloor/protocol";
import type { Viewer } from "./wire.js";

export type ConnectDecision =
  | { allowed: true; state: OfficeState; viewer?: Viewer }
  | { allowed: false; reason: "unauthenticated" | "not_found" | "unavailable" };

export interface ConnectAuthorizer {
  authorize(officeId: string, req: IncomingMessage): Promise<ConnectDecision>;
}

export interface ApiConnectAuthorizerOptions {
  /** Where `apps/api` listens, e.g. `http://api:8787`. */
  apiUrl: string;
  fetchImpl?: typeof fetch | undefined;
  /** Give up on the api rather than hold an upgrade open forever. */
  timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export class ApiConnectAuthorizer implements ConnectAuthorizer {
  readonly #apiUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ApiConnectAuthorizerOptions) {
    this.#apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async authorize(officeId: string, req: IncomingMessage): Promise<ConnectDecision> {
    const [owner, repo] = officeId.split("/");
    if (!owner || !repo) return { allowed: false, reason: "not_found" };

    const url = `${this.#apiUrl}/office/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    let response: Response;
    try {
      response = await this.#withTimeout((signal) =>
        this.#fetch(url, { headers: forwardedCredentials(req), signal }),
      );
    } catch {
      // Unreachable api, timeout, DNS — all the same answer: we cannot tell, so no.
      return { allowed: false, reason: "unavailable" };
    }

    if (response.status === 401) return { allowed: false, reason: "unauthenticated" };
    if (response.status === 404) return { allowed: false, reason: "not_found" };
    if (!response.ok) return { allowed: false, reason: "unavailable" };

    let state: OfficeState;
    try {
      state = (await response.json()) as OfficeState;
    } catch {
      return { allowed: false, reason: "unavailable" };
    }

    const viewer = await this.#identify(req);
    return viewer ? { allowed: true, state, viewer } : { allowed: true, state };
  }

  /**
   * Who is signed in, for presence. A failure here is not a reason to refuse the
   * socket: the read was already authorized, and an unnamed viewer simply does not
   * appear on the floor.
   */
  async #identify(req: IncomingMessage): Promise<Viewer | undefined> {
    const cookie = req.headers.cookie;
    if (!cookie) return undefined;

    try {
      const response = await this.#withTimeout((signal) =>
        this.#fetch(`${this.#apiUrl}/auth/me`, { headers: { cookie }, signal }),
      );
      if (!response.ok) return undefined;
      const body = (await response.json()) as { login?: unknown; avatarUrl?: unknown };
      if (typeof body.login !== "string" || body.login.length === 0) return undefined;
      return typeof body.avatarUrl === "string"
        ? { login: body.login, avatarUrl: body.avatarUrl }
        : { login: body.login };
    } catch {
      return undefined;
    }
  }

  async #withTimeout(fn: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The client's own credentials and nothing else. Explicitly *not* a blanket header
 * copy: forwarding `host`, `origin` or a `x-forwarded-*` chain to an internal service
 * is how a request smuggles intent it was never given.
 */
export function forwardedCredentials(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization) headers["authorization"] = authorization;
  const cookie = req.headers.cookie;
  if (typeof cookie === "string" && cookie) headers["cookie"] = cookie;
  return headers;
}
