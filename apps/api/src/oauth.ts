/**
 * The OAuth leg of the GitHub App — "Sign in with GitHub".
 *
 * A GitHub App's user authorization has no `scope` parameter: what the resulting token
 * can see is decided by the App's permissions and where it is installed, not by the
 * sign-in link. That suits us exactly, because the token is only ever used to ask
 * GitHub "can this user read this repository?" (access.ts).
 *
 * Two hosts are involved and they are not the same: the browser is sent to
 * `GITHUB_WEB_URL` (github.com), and the API calls go to `GITHUB_API_URL`
 * (api.github.com). GHES puts them elsewhere, which is why both are configurable.
 */

import { DEFAULT_GITHUB_API_URL } from "./access.js";

export const DEFAULT_GITHUB_WEB_URL = "https://github.com";

export interface GitHubOAuthOptions {
  clientId: string;
  clientSecret: string;
  /** Where the browser is sent. Default https://github.com. */
  webUrl?: string | undefined;
  /** Where the API calls go. Default https://api.github.com. */
  apiUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface GitHubUser {
  login: string;
  id: number;
  avatarUrl?: string | undefined;
}

export class GitHubOAuth {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #webUrl: string;
  readonly #apiUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubOAuthOptions) {
    if (!options.clientId) throw new Error("GitHubOAuth: clientId is required");
    if (!options.clientSecret) throw new Error("GitHubOAuth: clientSecret is required");
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#webUrl = (options.webUrl ?? DEFAULT_GITHUB_WEB_URL).replace(/\/+$/, "");
    this.#apiUrl = (options.apiUrl ?? DEFAULT_GITHUB_API_URL).replace(/\/+$/, "");
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /** Where to send the browser to start a sign-in. */
  authorizeUrl(params: { state: string; redirectUri: string }): string {
    const url = new URL(`${this.#webUrl}/login/oauth/authorize`);
    url.searchParams.set("client_id", this.#clientId);
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("state", params.state);
    return url.toString();
  }

  /** Where to send the browser to install the App (or add repositories to it). */
  installUrl(appSlug: string, params: { state?: string | undefined } = {}): string {
    const url = new URL(`${this.#webUrl}/apps/${encodeURIComponent(appSlug)}/installations/new`);
    if (params.state) url.searchParams.set("state", params.state);
    return url.toString();
  }

  /**
   * The callback `code` for a user access token.
   *
   * GitHub answers `200` with `{"error": ...}` for a bad or replayed code, so the
   * status alone is not enough to tell success from failure.
   */
  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const res = await this.#fetch(`${this.#webUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "repofloor-api",
      },
      body: JSON.stringify({
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) throw new Error(`github_oauth_status_${res.status}`);

    const body = (await res.json()) as { access_token?: unknown; error?: unknown };
    if (typeof body.error === "string") throw new Error(`github_oauth_${body.error}`);
    if (typeof body.access_token !== "string" || body.access_token.length === 0) {
      throw new Error("github_oauth_no_token");
    }
    return body.access_token;
  }

  /** Who the token belongs to: `GET /user`. */
  async viewer(token: string): Promise<GitHubUser> {
    const res = await this.#fetch(`${this.#apiUrl}/user`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "repofloor-api",
      },
    });
    if (!res.ok) throw new Error(`github_user_status_${res.status}`);

    const body = (await res.json()) as { login?: unknown; id?: unknown; avatar_url?: unknown };
    if (typeof body.login !== "string" || !Number.isInteger(Number(body.id))) {
      throw new Error("github_user_unexpected_shape");
    }
    return {
      login: body.login,
      id: Number(body.id),
      ...(typeof body.avatar_url === "string" ? { avatarUrl: body.avatar_url } : {}),
    };
  }
}
