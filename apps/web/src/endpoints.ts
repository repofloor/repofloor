/**
 * Where the browser talks. Pure string building, so it can be tested without a DOM.
 *
 * Both bases default to empty, which means "this page's own origin" — the deployment
 * ADR 0001 describes, with one proxy in front of api, realtime and these files.
 */

/** Trailing slashes off; `""` stays `""`. */
export function normalizeBase(base: string): string {
  return base.replace(/\/+$/, "");
}

export function officeApiPath(officeId: string): string {
  const [owner, repo] = officeId.split("/");
  if (!owner || !repo) throw new Error(`officeApiPath: not an office id: ${officeId}`);
  return `/office/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/**
 * The socket URL for an office.
 *
 * With no configured base the page's own origin is used, with the scheme swapped:
 * `https:` → `wss:`, anything else → `ws:`. A configured base may be `ws://`,
 * `wss://`, or an `http(s)://` address that is converted the same way, so the same
 * environment variable works whichever form an operator reaches for.
 */
export function socketUrl(base: string, officeId: string, pageOrigin: string): string {
  const root = normalizeBase(base) || pageOrigin;
  const wsRoot = root.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  if (!/^wss?:\/\//.test(wsRoot)) throw new Error(`socketUrl: not an origin: ${base || pageOrigin}`);
  return `${wsRoot}${officeApiPath(officeId)}`;
}

/** Sign-in sends the browser to GitHub and back to where it was. */
export function signInPath(returnTo: string): string {
  return `/auth/github?return_to=${encodeURIComponent(returnTo)}`;
}
