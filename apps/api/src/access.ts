/**
 * Read authorization for `GET /office/:owner/:repo`.
 *
 * CLAUDE.md rule 6 and ADR 0001: **GitHub is the only ACL**. We never keep a table of
 * who may read what. The check is "ask GitHub, with the caller's own token, whether it
 * can see this repository" — `GET /repos/{owner}/{repo}` — cached by (caller, repo) for
 * a short TTL and invalidated when a webhook says access changed.
 *
 * Identity seam (deliberately the smallest honest one, a session flow is a later
 * slice): the caller presents a GitHub token as `Authorization: Bearer <token>`. That
 * token *is* the identity — we never learn a login and never store the token; the cache
 * key is a salted hash of it. Public offices need no token at all, because the snapshot
 * itself records `office.private`, which comes from signed GitHub deliveries.
 */

import { createHash, randomBytes } from "node:crypto";

export type AccessDecision =
  | { allowed: true; cached: boolean }
  /** No token presented for a private office. */
  | { allowed: false; reason: "unauthenticated" }
  /** GitHub says this caller cannot see the repository. */
  | { allowed: false; reason: "forbidden"; cached: boolean }
  /** GitHub could not be reached or answered 5xx — we fail closed. */
  | { allowed: false; reason: "unavailable" };

export interface RepoAccess {
  /** May the holder of `token` read the office "owner/repo"? */
  canRead(officeId: string, token: string | undefined): Promise<AccessDecision>;
  /** Forget every cached answer about this office. */
  invalidateOffice(officeId: string): void;
}

export const DEFAULT_ACCESS_TTL_MS = 60_000;
export const DEFAULT_GITHUB_API_URL = "https://api.github.com";

export interface GitHubRepoAccessOptions {
  apiUrl?: string | undefined;
  /** How long an answer — positive or negative — is reused. ADR 0001 says short. */
  ttlMs?: number | undefined;
  /** Cap on cached decisions; the oldest are dropped first. */
  maxEntries?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => number) | undefined;
}

interface CacheEntry {
  allowed: boolean;
  expiresAt: number;
}

export class GitHubRepoAccess implements RepoAccess {
  readonly #apiUrl: string;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  /** Per-process salt: cache keys are useless outside this process. */
  readonly #salt = randomBytes(16);
  readonly #cache = new Map<string, CacheEntry>();
  /** officeId → its cache keys, so webhook invalidation is a single lookup. */
  readonly #byOffice = new Map<string, Set<string>>();

  constructor(options: GitHubRepoAccessOptions = {}) {
    this.#apiUrl = (options.apiUrl ?? DEFAULT_GITHUB_API_URL).replace(/\/+$/, "");
    this.#ttlMs = options.ttlMs ?? DEFAULT_ACCESS_TTL_MS;
    this.#maxEntries = options.maxEntries ?? 10_000;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async canRead(officeId: string, token: string | undefined): Promise<AccessDecision> {
    if (!token) return { allowed: false, reason: "unauthenticated" };

    const key = this.#key(officeId, token);
    const hit = this.#cache.get(key);
    if (hit && hit.expiresAt > this.#now()) {
      return hit.allowed ? { allowed: true, cached: true } : { allowed: false, reason: "forbidden", cached: true };
    }

    let allowed: boolean;
    try {
      allowed = await this.#ask(officeId, token);
    } catch {
      // Never cache an unknown: a GitHub outage must not pin anyone out (or in) for a
      // minute, and it must not open an office either.
      return { allowed: false, reason: "unavailable" };
    }

    this.#remember(officeId, key, allowed);
    return allowed ? { allowed: true, cached: false } : { allowed: false, reason: "forbidden", cached: false };
  }

  invalidateOffice(officeId: string): void {
    const keys = this.#byOffice.get(officeId);
    if (!keys) return;
    for (const key of keys) this.#cache.delete(key);
    this.#byOffice.delete(officeId);
  }

  /** Cached decisions, for tests and logging. */
  get size(): number {
    return this.#cache.size;
  }

  /**
   * One request to GitHub. A 200 means the token can see the repository, which is
   * exactly "can read" — GitHub answers 404 for private repositories you cannot see,
   * and 403 when the token is blocked or over its rate limit.
   */
  async #ask(officeId: string, token: string): Promise<boolean> {
    const [owner, repo] = officeId.split("/");
    if (!owner || !repo) return false;

    const res = await this.#fetch(
      `${this.#apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "repofloor-api",
        },
      },
    );

    if (res.status === 200) return true;
    if (res.status === 401 || res.status === 403 || res.status === 404) return false;
    throw new Error(`github_repos_status_${res.status}`);
  }

  #key(officeId: string, token: string): string {
    const digest = createHash("sha256").update(this.#salt).update(token).digest("hex").slice(0, 32);
    return `${digest}:${officeId}`;
  }

  #remember(officeId: string, key: string, allowed: boolean): void {
    if (this.#cache.size >= this.#maxEntries && !this.#cache.has(key)) {
      // Map preserves insertion order: the oldest entry goes.
      const oldest = this.#cache.keys().next();
      if (!oldest.done) {
        this.#cache.delete(oldest.value);
        for (const keys of this.#byOffice.values()) keys.delete(oldest.value);
      }
    }
    this.#cache.set(key, { allowed, expiresAt: this.#now() + this.#ttlMs });
    const keys = this.#byOffice.get(officeId) ?? new Set<string>();
    keys.add(key);
    this.#byOffice.set(officeId, keys);
  }
}

/** `Authorization: Bearer <token>` (also `token <token>`, which GitHub's own docs use). */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return undefined;
  const match = value.match(/^(?:bearer|token)\s+(\S+)$/i);
  return match?.[1];
}

type Obj = Record<string, unknown>;

/**
 * The offices whose cached decisions a delivery invalidates.
 *
 * `installation_repositories` is the App being granted or revoked repositories, and
 * `member` is a collaborator being added to or removed from one. Both change who can
 * read, so the cached answers for those offices are dropped immediately instead of
 * waiting out the TTL (ADR 0001).
 */
export function accessInvalidations(event: string, payload: Obj): string[] {
  const offices = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.includes("/")) offices.add(value);
  };

  if (event === "installation_repositories" || event === "installation") {
    for (const field of ["repositories_added", "repositories_removed", "repositories"]) {
      const list = payload[field];
      if (Array.isArray(list)) for (const repo of list) add((repo as Obj | null)?.["full_name"]);
    }
  }

  if (event === "member" || event === "team" || event === "membership") {
    const repo = payload["repository"];
    if (repo && typeof repo === "object") add((repo as Obj)["full_name"]);
    const repos = payload["repositories"];
    if (Array.isArray(repos)) for (const r of repos) add((r as Obj | null)?.["full_name"]);
  }

  return [...offices];
}
