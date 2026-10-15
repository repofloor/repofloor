/**
 * The api, as this page sees it.
 *
 * Every call is same-origin and carries the session cookie; nothing here ever handles
 * a GitHub token, because the whole point of the api holding sessions in memory is
 * that the browser never sees one.
 *
 * The failure vocabulary is small on purpose, and rule 6 is why: `404` and a refused
 * read are the same answer from the api (whether a private repository exists is itself
 * private), so this page cannot do anything cleverer than offer to sign in. There is no
 * second ACL to consult and no "you need access" to render, because we do not know that.
 */

import { assertOfficeState, type OfficeState } from "@repofloor/protocol";
import { normalizeBase, officeApiPath } from "./endpoints.js";

export type FailureKind =
  /** Not signed in (or signed out), and the thing asked for is not public. */
  | "unauthenticated"
  /** No such office — or one we may not know about. Identical answers, deliberately. */
  | "not_found"
  /** The api could not ask GitHub, or is not there. Try again later. */
  | "unavailable"
  /** The network failed under us. */
  | "offline"
  /** A 2xx we could not make sense of. */
  | "bad_response";

export class ApiError extends Error {
  readonly kind: FailureKind;
  readonly status: number | undefined;

  constructor(kind: FailureKind, status?: number, message?: string) {
    super(message ?? `${kind}${status ? ` (${status})` : ""}`);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

/** HTTP status → what the page should do about it. */
export function failureFor(status: number): FailureKind {
  if (status === 401) return "unauthenticated";
  if (status === 404) return "not_found";
  if (status === 403) return "not_found";
  return "unavailable";
}

/** `GET /auth/me`. */
export interface Viewer {
  login: string;
  id: number;
  avatarUrl?: string;
  expiresAt: string;
}

/** One row of `GET /offices`. Mirrors `OfficeSummary` in `apps/api/src/authorize.ts`. */
export interface OfficeSummary {
  officeId: string;
  name: string;
  buildingId: string;
  private?: boolean;
  generatedAt: string;
  actors: number;
}

export interface OfficeListing {
  offices: OfficeSummary[];
  /**
   * The api left at least one office out because GitHub could not be asked about it.
   * Shown to the reader rather than swallowed: a short list that looks complete is
   * worse than a short list that says it is short.
   */
  partial: boolean;
}

export interface ApiClientOptions {
  /** Empty means this page's own origin, which is the deployment we document. */
  base?: string;
  fetchImpl?: typeof fetch;
}

export class ApiClient {
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(options: ApiClientOptions = {}) {
    this.#base = normalizeBase(options.base ?? "");
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Who is signed in, or `null`. Not an error: being anonymous is a normal state. */
  async viewer(): Promise<Viewer | null> {
    try {
      return await this.#get<Viewer>("/auth/me");
    } catch (err) {
      // 501 (sign-in not configured) and 401 (nobody signed in) are both "no viewer".
      if (err instanceof ApiError && (err.kind === "unauthenticated" || err.status === 501)) return null;
      throw err;
    }
  }

  async offices(): Promise<OfficeListing> {
    const listing = await this.#get<OfficeListing>("/offices");
    if (!Array.isArray(listing.offices)) throw new ApiError("bad_response");
    return { offices: listing.offices, partial: listing.partial === true };
  }

  async office(officeId: string): Promise<OfficeState> {
    const state = await this.#get<unknown>(officeApiPath(officeId));
    try {
      assertOfficeState(state);
    } catch (err) {
      throw new ApiError("bad_response", 200, err instanceof Error ? err.message : undefined);
    }
    return state;
  }

  async logout(): Promise<void> {
    await this.#request("/auth/logout", { method: "POST" });
  }

  async #get<T>(path: string): Promise<T> {
    const response = await this.#request(path, { method: "GET" });
    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError("bad_response", response.status);
    }
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}${path}`, {
        ...init,
        // Same-origin is the default, stated anyway: the session cookie is the only
        // identity this page has, and losing it silently would look like a 401.
        credentials: "same-origin",
        headers: { accept: "application/json", ...(init.headers ?? {}) },
        cache: "no-store",
      });
    } catch {
      throw new ApiError("offline");
    }
    if (!response.ok) throw new ApiError(failureFor(response.status), response.status);
    return response;
  }
}
