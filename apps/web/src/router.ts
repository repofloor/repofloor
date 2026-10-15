/**
 * History routing, in thirty lines.
 *
 * Internal links are plain `<a href="/owner/repo">`, intercepted here, so the page
 * works with middle-click, ctrl-click and the back button without any of them being
 * special-cased. Links that leave the site (GitHub, `/auth/github`) are left alone:
 * `data-external` marks the ones on our own origin that must be a real navigation,
 * because a redirect to GitHub is not something `pushState` can do.
 */

import { parseRoute, type Route } from "./route.js";

export interface Router {
  /** Current route; re-read after every navigation. */
  route: () => Route;
  go: (path: string) => void;
  start: () => void;
}

export function createRouter(render: (route: Route) => void): Router {
  const current = () => parseRoute(location.pathname);

  function go(path: string): void {
    if (path === location.pathname + location.search) return;
    history.pushState(null, "", path);
    render(current());
  }

  function onClick(event: MouseEvent): void {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const anchor = (event.target as Element | null)?.closest("a");
    if (!anchor) return;
    if (anchor.hasAttribute("data-external") || anchor.target === "_blank") return;
    const href = anchor.getAttribute("href");
    if (!href || !href.startsWith("/") || href.startsWith("//")) return;
    event.preventDefault();
    go(href);
  }

  return {
    route: current,
    go,
    start() {
      document.addEventListener("click", onClick);
      window.addEventListener("popstate", () => render(current()));
      render(current());
    },
  };
}
