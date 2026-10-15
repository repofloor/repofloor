/**
 * "Sign in with GitHub", and the GitHub App installation callback.
 *
 * What this adds to the service, in one sentence: a browser can now read a private
 * office without anybody pasting a token, because the token is held here instead.
 *
 *   GET  /auth/github            → 302 to GitHub, with a signed `state` cookie
 *   GET  /auth/github/callback   → code for token, token into a session, 302 back
 *   GET  /auth/me                → who the session belongs to (never the token)
 *   POST /auth/logout            → destroy the session, clear the cookie
 *   GET  /auth/install           → 302 to GitHub's "install this App" page
 *   GET  /auth/install/callback  → the App's Setup URL: `installation_id` + `setup_action`
 *
 * What it does **not** add: a second ACL (CLAUDE.md rule 6). A session is an identity,
 * not a permission. `GET /office/...` still ends in `RepoAccess.canRead`, which asks
 * GitHub about this user's token; signing in only changes *where the token comes from*.
 * An installation row likewise grants nobody a read.
 *
 * CSRF on the sign-in itself: the `state` parameter is also kept in a short-lived,
 * signed, HttpOnly cookie, and the callback requires the two to match. A callback
 * replayed or forged by a third party has no matching cookie and is refused.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { addCookie, json, redirect, safeReturnTo } from "./http.js";
import type { GitHubAppAuth } from "./app-auth.js";
import type { InstallationStore } from "./installations.js";
import type { GitHubOAuth, GitHubUser } from "./oauth.js";
import {
  newNonce,
  parseCookies,
  serializeCookie,
  signValue,
  unsignValue,
  type CookieOptions,
  type Session,
  type SessionStore,
} from "./session.js";

export const SESSION_COOKIE = "rf_session";
export const OAUTH_STATE_COOKIE = "rf_oauth";
/** The sign-in round trip is a redirect and a form post; ten minutes is plenty. */
export const OAUTH_STATE_TTL_SECONDS = 600;

export interface SignInOptions {
  oauth: GitHubOAuth;
  sessions: SessionStore;
  /** Signs the session and state cookies. Long and random; rotating it signs everyone out. */
  cookieSecret: string;
  /** Our own public origin, e.g. https://repofloor.example. The `redirect_uri` is built from it. */
  baseUrl: string;
  /** Needed to record installations and to act as the App; without it install is just a redirect. */
  appAuth?: GitHubAppAuth | undefined;
  installations?: InstallationStore | undefined;
  /** The App's slug, for the install link. */
  appSlug?: string | undefined;
  /** Session cookie lifetime, seconds. Default: a working day. */
  cookieMaxAge?: number | undefined;
}

interface StatePayload {
  /** Nonce, matched against the cookie. */
  n: string;
  /** Where to send the browser afterwards. Always a path on our own site. */
  r: string;
}

interface RecordResult {
  status: number;
  reason?: string | undefined;
  installationId?: number | undefined;
  account?: string | undefined;
}

export class SignIn {
  readonly #oauth: GitHubOAuth;
  readonly #sessions: SessionStore;
  readonly #secret: string;
  readonly #baseUrl: string;
  readonly #appAuth: GitHubAppAuth | undefined;
  readonly #installations: InstallationStore | undefined;
  readonly #appSlug: string | undefined;
  readonly #cookieMaxAge: number;
  /** Secure cookies need https; over plain http the browser would drop them. */
  readonly #secure: boolean;

  constructor(options: SignInOptions) {
    if (!options.cookieSecret) throw new Error("SignIn: cookieSecret is required");
    if (!options.baseUrl) throw new Error("SignIn: baseUrl is required");
    this.#oauth = options.oauth;
    this.#sessions = options.sessions;
    this.#secret = options.cookieSecret;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#appAuth = options.appAuth;
    this.#installations = options.installations;
    this.#appSlug = options.appSlug;
    this.#cookieMaxAge = options.cookieMaxAge ?? 12 * 60 * 60;
    this.#secure = this.#baseUrl.startsWith("https://");
  }

  /** `${baseUrl}/auth/github/callback` — must match the App's callback URL exactly. */
  get redirectUri(): string {
    return `${this.#baseUrl}/auth/github/callback`;
  }

  /** The session this request carries, if any. Bad or expired cookies are simply absent. */
  async currentSession(req: IncomingMessage): Promise<Session | undefined> {
    const signed = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const id = unsignValue(this.#secret, signed);
    if (!id) return undefined;
    return this.#sessions.get(id);
  }

  /**
   * The GitHub token to authorize a read with, taken from the session.
   * `GET /office/...` prefers an explicit `Authorization` header and falls back to this.
   */
  async sessionToken(req: IncomingMessage): Promise<string | undefined> {
    return (await this.currentSession(req))?.token;
  }

  /** Start a sign-in: remember a nonce, send the browser to GitHub. */
  begin(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const payload: StatePayload = { n: newNonce(), r: safeReturnTo(url.searchParams.get("return_to")) };
    const state = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

    addCookie(
      res,
      serializeCookie(OAUTH_STATE_COOKIE, signValue(this.#secret, state), {
        ...this.#cookieOptions(),
        maxAge: OAUTH_STATE_TTL_SECONDS,
      }),
    );
    redirect(res, this.#oauth.authorizeUrl({ state, redirectUri: this.redirectUri }));
  }

  /** Finish a sign-in: validate the state, exchange the code, open a session. */
  async callback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    // Clear the state cookie whatever happens: it is single-use.
    addCookie(res, serializeCookie(OAUTH_STATE_COOKIE, "", { ...this.#cookieOptions(), maxAge: 0 }));

    const denied = url.searchParams.get("error");
    if (denied) return json(res, 400, { error: "github_denied", detail: denied });

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) return json(res, 400, { error: "missing_code_or_state" });

    const expected = unsignValue(this.#secret, parseCookies(req.headers.cookie)[OAUTH_STATE_COOKIE]);
    if (!expected || !sameString(expected, state)) return json(res, 400, { error: "state_mismatch" });

    const payload = decodeState(state);
    if (!payload) return json(res, 400, { error: "state_mismatch" });

    let token: string;
    let user: GitHubUser;
    try {
      token = await this.#oauth.exchangeCode(code, this.redirectUri);
      user = await this.#oauth.viewer(token);
    } catch (err) {
      console.error("[api] sign-in failed", err instanceof Error ? err.message : err);
      return json(res, 502, { error: "github_unavailable" });
    }

    const session = await this.#sessions.create({
      login: user.login,
      userId: user.id,
      ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
      token,
    });

    addCookie(
      res,
      serializeCookie(SESSION_COOKIE, signValue(this.#secret, session.id), {
        ...this.#cookieOptions(),
        maxAge: this.#cookieMaxAge,
      }),
    );

    // The App can ask for user authorization *during* installation, in which case this
    // same callback carries the installation. Record it rather than waiting for the
    // `installation` delivery.
    const installationId = url.searchParams.get("installation_id");
    if (installationId) await this.#recordInstallation(installationId);

    redirect(res, this.#absolute(safeReturnTo(payload.r)));
  }

  /** Who is signed in. Never the token — that is the whole point of holding it here. */
  async me(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = await this.currentSession(req);
    if (!session) return json(res, 401, { error: "unauthenticated" });
    return json(res, 200, {
      login: session.login,
      id: session.userId,
      ...(session.avatarUrl ? { avatarUrl: session.avatarUrl } : {}),
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  }

  /** Destroy the session server-side, then clear the cookie. */
  async logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = unsignValue(this.#secret, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (id) await this.#sessions.destroy(id);
    addCookie(res, serializeCookie(SESSION_COOKIE, "", { ...this.#cookieOptions(), maxAge: 0 }));
    return json(res, 200, { ok: true });
  }

  /** Send the browser to GitHub's install page for this App. */
  install(req: IncomingMessage, res: ServerResponse): void {
    if (!this.#appSlug) return json(res, 501, { error: "app_slug_not_configured" });
    redirect(res, this.#oauth.installUrl(this.#appSlug));
  }

  /**
   * The App's **Setup URL**, where GitHub lands the owner after an install, with
   * `installation_id` and `setup_action` in the query.
   *
   * Nothing here is signed, so `installation_id` is caller-supplied. We do not take its
   * word for anything: the installation is read back from GitHub as the App
   * (`GET /app/installations/{id}`), which only answers for installations that really
   * are ours, and only what GitHub says is stored.
   *
   * Set the Setup URL with a `return_to` query of your own (GitHub keeps it and appends
   * its own parameters) to be redirected into the web app instead of seeing this JSON.
   */
  async installCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const setupAction = url.searchParams.get("setup_action") ?? undefined;
    const result = await this.#recordInstallation(url.searchParams.get("installation_id"));

    const returnTo = url.searchParams.get("return_to");
    if (returnTo) return redirect(res, this.#absolute(safeReturnTo(returnTo)));

    return json(res, result.status, {
      ...(result.status === 200 ? { ok: true } : { error: result.reason }),
      ...(setupAction ? { setupAction } : {}),
      ...(result.installationId ? { installationId: result.installationId } : {}),
      ...(result.account ? { account: result.account } : {}),
    });
  }

  /**
   * Read an installation back from GitHub and store it. Everything here is optional —
   * without App credentials or a store the service still signs people in, it just
   * cannot act as the App afterwards.
   */
  async #recordInstallation(raw: string | null): Promise<RecordResult> {
    if (!raw) return { status: 400, reason: "missing_installation_id" };
    const installationId = Number(raw);
    if (!Number.isInteger(installationId) || installationId <= 0) {
      return { status: 400, reason: "invalid_installation_id" };
    }
    if (!this.#appAuth || !this.#installations) {
      return { status: 501, reason: "app_credentials_not_configured", installationId };
    }

    try {
      const installation = await this.#appAuth.fetchInstallation(installationId);
      if (!installation) return { status: 404, reason: "unknown_installation", installationId };
      await this.#installations.upsert(installation);
      return { status: 200, installationId, account: installation.accountLogin };
    } catch (err) {
      console.error("[api] could not record installation", installationId, err instanceof Error ? err.message : err);
      return { status: 502, reason: "github_unavailable", installationId };
    }
  }

  #cookieOptions(): CookieOptions {
    return { path: "/", httpOnly: true, secure: this.#secure, sameSite: "Lax" };
  }

  /** Redirects stay on our own origin; `safeReturnTo` has already vetted the path. */
  #absolute(path: string): string {
    return `${this.#baseUrl}${path}`;
  }
}

function decodeState(state: string): StatePayload | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { n, r } = parsed as Record<string, unknown>;
    if (typeof n !== "string" || n.length === 0) return undefined;
    return { n, r: typeof r === "string" ? r : "/" };
  } catch {
    return undefined;
  }
}

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
