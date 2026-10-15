/**
 * Acting as the GitHub App.
 *
 * Two credentials, two lifetimes:
 *
 *   App JWT              signed here with the App's private key (RS256), valid ~10 min,
 *                        the only thing that can talk to `/app/...` endpoints.
 *   Installation token   minted with that JWT via
 *                        `POST /app/installations/{id}/access_tokens`, valid 1 hour,
 *                        scoped to one installation's repositories.
 *
 * Installation tokens are cached **in memory only** and never written to the database:
 * they expire within the hour, so persisting them would buy nothing and leave a
 * credential at rest. `installations` (migrations/002) holds the account, not the key.
 *
 * `node:crypto` signs the JWT, so this stays dependency-free — ADR 0001 keeps the
 * runtime dependency list to `pg`.
 */

import { createSign } from "node:crypto";
import { installationFromPayload, type Installation } from "./installations.js";
import { DEFAULT_GITHUB_API_URL } from "./access.js";

/** How long an App JWT is asked to live. GitHub's hard ceiling is 10 minutes. */
export const APP_JWT_TTL_SECONDS = 9 * 60;
/** Clock skew GitHub tolerates on `iat`; back-date by this much. */
export const APP_JWT_BACKDATE_SECONDS = 60;
/** Mint a fresh installation token this long before the old one expires. */
export const INSTALLATION_TOKEN_SKEW_MS = 60_000;

export interface GitHubAppAuthOptions {
  /** The App id (a number, but GitHub shows it as a string and we only echo it). */
  appId: string;
  /** The App's private key, PEM. `\n`-escaped newlines are accepted. */
  privateKey: string;
  apiUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => number) | undefined;
}

interface CachedToken {
  token: string;
  /** Epoch ms at which GitHub says the token stops working. */
  expiresAt: number;
}

export class GitHubAppAuth {
  readonly #appId: string;
  readonly #privateKey: string;
  readonly #apiUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #tokens = new Map<number, CachedToken>();
  /** In-flight mints, so a burst of requests makes one call to GitHub, not twenty. */
  readonly #pending = new Map<number, Promise<string>>();

  constructor(options: GitHubAppAuthOptions) {
    if (!options.appId) throw new Error("GitHubAppAuth: appId is required");
    if (!options.privateKey) throw new Error("GitHubAppAuth: privateKey is required");
    this.#appId = options.appId;
    this.#privateKey = normalizePem(options.privateKey);
    this.#apiUrl = (options.apiUrl ?? DEFAULT_GITHUB_API_URL).replace(/\/+$/, "");
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  /** A freshly signed App JWT. Cheap enough to sign per call. */
  appJwt(): string {
    const seconds = Math.floor(this.#now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iat: seconds - APP_JWT_BACKDATE_SECONDS,
      exp: seconds + APP_JWT_TTL_SECONDS,
      iss: this.#appId,
    };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signature = createSign("RSA-SHA256").update(signingInput).sign(this.#privateKey).toString("base64url");
    return `${signingInput}.${signature}`;
  }

  /**
   * A token for one installation, reused until shortly before it expires.
   * Throws if GitHub refuses — callers decide whether that is fatal.
   */
  async installationToken(installationId: number): Promise<string> {
    const cached = this.#tokens.get(installationId);
    if (cached && cached.expiresAt - INSTALLATION_TOKEN_SKEW_MS > this.#now()) return cached.token;

    const inflight = this.#pending.get(installationId);
    if (inflight) return inflight;

    const mint = this.#mint(installationId).finally(() => this.#pending.delete(installationId));
    this.#pending.set(installationId, mint);
    return mint;
  }

  /** What GitHub knows about an installation, asked as the App. */
  async fetchInstallation(installationId: number): Promise<Installation | undefined> {
    const res = await this.#fetch(`${this.#apiUrl}/app/installations/${installationId}`, {
      headers: this.#headers(this.appJwt()),
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`github_app_installations_status_${res.status}`);
    return installationFromPayload(await res.json());
  }

  /** Forget a cached token, e.g. after a `installation` suspend/revoke delivery. */
  invalidate(installationId: number): void {
    this.#tokens.delete(installationId);
  }

  /** Cached tokens, for tests and logging. */
  get size(): number {
    return this.#tokens.size;
  }

  async #mint(installationId: number): Promise<string> {
    const res = await this.#fetch(`${this.#apiUrl}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: this.#headers(this.appJwt()),
    });
    if (!res.ok) throw new Error(`github_installation_token_status_${res.status}`);

    const body = (await res.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof body.token !== "string" || body.token.length === 0) throw new Error("github_installation_token_missing");

    const expiresAt =
      typeof body.expires_at === "string" && !Number.isNaN(Date.parse(body.expires_at))
        ? Date.parse(body.expires_at)
        : // GitHub documents one hour; assume it rather than caching forever.
          this.#now() + 60 * 60 * 1000;

    this.#tokens.set(installationId, { token: body.token, expiresAt });
    return body.token;
  }

  #headers(bearer: string): Record<string, string> {
    return {
      authorization: `Bearer ${bearer}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "repofloor-api",
    };
  }
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * Environment variables cannot hold real newlines in every deployment target, so a PEM
 * is commonly pasted with `\n` escapes. Accept both spellings.
 */
export function normalizePem(key: string): string {
  const pem = key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
  return pem.endsWith("\n") ? pem : `${pem}\n`;
}
