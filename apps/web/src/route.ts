/**
 * The three pages, parsed out of a pathname.
 *
 *   /                     every building this viewer may see
 *   /:owner               one building: its offices
 *   /:owner/:repo         one office: the floor
 *   /installed            where GitHub lands an owner after installing the App
 *
 * `/:owner/:repo` is deliberately *not* `/office/:owner/:repo`: that path belongs to
 * `apps/api` and to the socket, and the two live on the same origin as this page.
 *
 * The owner and repository patterns are GitHub's own, copied here rather than imported
 * because this package must not depend on a server package. They are also the reason
 * an unknown route is a 404 page and not an attempt: `/favicon.ico` and `/assets/x.js`
 * do not look like a building.
 */

export type Route =
  | { kind: "home" }
  | { kind: "installed" }
  | { kind: "building"; owner: string }
  | { kind: "office"; owner: string; repo: string }
  | { kind: "unknown"; path: string };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9._-]+$/;

/**
 * First segments that are not an owner, because something else on this origin already
 * answers to them: the api's routes and the bundle's own assets. `assets` is the one
 * that matters — a GitHub owner could legitimately be called that, and `/assets/x.js`
 * would otherwise parse as an office.
 */
const RESERVED = new Set(["assets", "auth", "office", "offices", "healthz", "webhook"]);

export function parseRoute(pathname: string): Route {
  const trimmed = pathname.replace(/\/+$/, "");
  if (trimmed === "" || trimmed === "/") return { kind: "home" };
  if (trimmed === "/installed") return { kind: "installed" };

  const segments = trimmed.slice(1).split("/");
  let decoded: string[];
  try {
    decoded = segments.map((s) => decodeURIComponent(s));
  } catch {
    // A malformed escape throws; it is not a page either way.
    return { kind: "unknown", path: pathname };
  }

  const [owner, repo] = decoded;
  if (owner !== undefined && RESERVED.has(owner)) return { kind: "unknown", path: pathname };
  if (decoded.length === 1 && owner !== undefined && OWNER.test(owner)) {
    return { kind: "building", owner };
  }
  if (decoded.length === 2 && owner !== undefined && repo !== undefined && OWNER.test(owner) && REPO.test(repo)) {
    return { kind: "office", owner, repo };
  }
  return { kind: "unknown", path: pathname };
}

/** The canonical path for a route, which is also what the links on the page use. */
export function routePath(route: Route): string {
  switch (route.kind) {
    case "home":
      return "/";
    case "installed":
      return "/installed";
    case "building":
      return `/${encodeURIComponent(route.owner)}`;
    case "office":
      return `/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}`;
    case "unknown":
      return route.path;
  }
}

/** `"owner/repo"` → the office page path, for a summary row straight out of the api. */
export function officePagePath(officeId: string): string {
  const [owner, repo] = officeId.split("/");
  if (!owner || !repo) return "/";
  return routePath({ kind: "office", owner, repo });
}
