/**
 * Server-side sessions, and the signed cookie that points at one.
 *
 * The shape, deliberately: the cookie carries a random session id and an HMAC of it,
 * nothing else. The user access token lives in the session record, server-side, and is
 * never serialized into a cookie, a URL, a log line or a response body — the browser
 * only ever holds an opaque id it cannot forge.
 *
 * The store is in memory, which means sessions do not survive a restart (a user signs
 * in again) and do not span processes. That is the honest trade for keeping credentials
 * out of the database entirely: the `installations` table holds accounts, not keys, and
 * there is nothing at rest to leak. `SessionStore` is the seam if that ever has to
 * change — a Postgres implementation would store an encrypted token and nothing above
 * this file would notice.
 *
 * `node:crypto` does the signing; no cookie library (ADR 0001 keeps `pg` the only
 * runtime dependency).
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/** Default session lifetime: a working day. */
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface Session {
  /** Opaque, 256 bits of randomness. The only part the browser sees. */
  id: string;
  login: string;
  userId: number;
  avatarUrl?: string | undefined;
  /**
   * The GitHub user access token. Server-side only: it is what `RepoAccess.canRead`
   * asks GitHub with, so a signed-in browser needs no token of its own.
   */
  token: string;
  createdAt: number;
  expiresAt: number;
}

/** Everything a sign-in knows; the store adds the id and the timestamps. */
export type NewSession = Omit<Session, "id" | "createdAt" | "expiresAt">;

export interface SessionStore {
  create(session: NewSession): Promise<Session>;
  get(id: string): Promise<Session | undefined>;
  destroy(id: string): Promise<void>;
}

export interface InMemorySessionStoreOptions {
  ttlMs?: number | undefined;
  /** Cap, so a flood of sign-ins cannot grow the process without bound. */
  maxSessions?: number | undefined;
  now?: (() => number) | undefined;
}

export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, Session>();
  readonly #ttlMs: number;
  readonly #maxSessions: number;
  readonly #now: () => number;

  constructor(options: InMemorySessionStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#maxSessions = options.maxSessions ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  async create(session: NewSession): Promise<Session> {
    this.#sweep();
    if (this.#sessions.size >= this.#maxSessions) {
      // Map preserves insertion order: the oldest session goes.
      const oldest = this.#sessions.keys().next();
      if (!oldest.done) this.#sessions.delete(oldest.value);
    }
    const now = this.#now();
    const record: Session = {
      ...session,
      id: randomBytes(32).toString("base64url"),
      createdAt: now,
      expiresAt: now + this.#ttlMs,
    };
    this.#sessions.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<Session | undefined> {
    const session = this.#sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt <= this.#now()) {
      this.#sessions.delete(id);
      return undefined;
    }
    return session;
  }

  async destroy(id: string): Promise<void> {
    this.#sessions.delete(id);
  }

  /** Live sessions, for tests and logging. */
  get size(): number {
    return this.#sessions.size;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(id);
    }
  }
}

/** `value.signature`, the signature being HMAC-SHA256 of the value under `secret`. */
export function signValue(secret: string, value: string): string {
  return `${value}.${createHmac("sha256", secret).update(value).digest("base64url")}`;
}

/** The value back, or undefined if the signature is missing, malformed or wrong. */
export function unsignValue(secret: string, signed: string | undefined): string | undefined {
  if (!secret || typeof signed !== "string") return undefined;
  const dot = signed.lastIndexOf(".");
  if (dot <= 0 || dot === signed.length - 1) return undefined;

  const value = signed.slice(0, dot);
  const expected = Buffer.from(signValue(secret, value), "utf8");
  const actual = Buffer.from(signed, "utf8");
  // timingSafeEqual throws on a length mismatch; a wrong length is a wrong signature.
  if (expected.length !== actual.length) return undefined;
  return timingSafeEqual(expected, actual) ? value : undefined;
}

/** A single-use nonce for the OAuth `state` parameter. */
export function newNonce(): string {
  return randomUUID();
}

/** `Cookie: a=1; b=2` into a map. Unparseable pairs are skipped, never thrown on. */
export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const value = Array.isArray(header) ? header.join("; ") : header;
  const cookies: Record<string, string> = {};
  if (typeof value !== "string") return cookies;

  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in cookies) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      cookies[name] = part.slice(eq + 1).trim();
    }
  }
  return cookies;
}

export interface CookieOptions {
  /** Seconds. `0` expires the cookie immediately, which is how we clear one. */
  maxAge?: number | undefined;
  path?: string | undefined;
  httpOnly?: boolean | undefined;
  /** Set when the public base URL is https; a cookie over plain http cannot be Secure. */
  secure?: boolean | undefined;
  sameSite?: "Strict" | "Lax" | "None" | undefined;
}

/** A `Set-Cookie` value. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? "/"}`];
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
    if (options.maxAge <= 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  }
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  return parts.join("; ");
}
