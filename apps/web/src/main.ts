/**
 * The shell: one header that says who you are, one `<main>` that the router swaps.
 *
 * `/auth/me` is asked once at boot and after a sign-out, and its answer decides the
 * header and the empty states — that is the whole of C2's "`/auth/me` decides what to
 * show". It decides nothing about access: a view still asks the api for what it wants
 * and renders whatever answer comes back, because the api is the only thing that knows
 * (rule 6).
 */

import { ApiClient, type Viewer } from "./api.js";
import { API_BASE } from "./config.js";
import { el } from "./dom.js";
import { signInPath } from "./endpoints.js";
import { createRouter } from "./router.js";
import type { Route } from "./route.js";
import { renderBuilding } from "./views/building.js";
import { renderBuildings, type View, type ViewContext } from "./views/buildings.js";
import { renderInstalled } from "./views/installed.js";
import { renderNotFound } from "./views/not-found.js";
import { renderOffice } from "./views/office.js";

const api = new ApiClient({ base: API_BASE });
const mount = document.getElementById("view") as HTMLElement;
const account = document.getElementById("account") as HTMLElement;

let viewer: Viewer | null = null;
let current: View | null = null;

function show(route: Route): void {
  // Every view owns a socket, a timer or both; dropping one without disposing it
  // leaves a connection open and a renderer rendering into a detached canvas.
  current?.dispose();
  current = null;

  const ctx: ViewContext = { api, viewer, mount, returnTo: location.pathname };
  switch (route.kind) {
    case "home":
      current = renderBuildings(ctx);
      document.title = "Repofloor";
      break;
    case "building":
      current = renderBuilding(ctx, route.owner);
      document.title = `${route.owner} · Repofloor`;
      break;
    case "office":
      current = renderOffice(ctx, route.owner, route.repo);
      document.title = `${route.owner}/${route.repo} · Repofloor`;
      break;
    case "installed":
      current = renderInstalled(ctx);
      document.title = "Installed · Repofloor";
      break;
    case "unknown":
      current = renderNotFound(ctx, route.path);
      document.title = "Not found · Repofloor";
      break;
  }
  // A route change is a new page to a reader using a screen reader too.
  mount.focus({ preventScroll: true });
}

const router = createRouter(show);

function renderAccount(): void {
  if (viewer) {
    const signOut = el("button", { class: "button button--quiet", type: "button" }, "Sign out");
    signOut.addEventListener("click", () => {
      signOut.disabled = true;
      void api.logout().finally(() => {
        viewer = null;
        renderAccount();
        show(router.route());
      });
    });
    account.replaceChildren(
      el(
        "span",
        { class: "account" },
        viewer.avatarUrl ? el("img", { class: "account__avatar", src: viewer.avatarUrl, alt: "", width: 20, height: 20 }) : null,
        el("span", { class: "account__login", text: viewer.login }),
      ),
      signOut,
    );
    return;
  }

  account.replaceChildren(
    el(
      "a",
      { class: "button button--primary", href: signInPath(location.pathname), "data-external": true },
      "Sign in with GitHub",
    ),
    el(
      "span",
      { class: "account__hint" },
      "Shows the private offices your GitHub account can already read.",
    ),
  );
}

async function boot(): Promise<void> {
  try {
    viewer = await api.viewer();
  } catch {
    // The api being unreachable is not a reason to render nothing: a public office
    // still loads, and the view that needs the api will say so itself.
    viewer = null;
  }
  renderAccount();
  router.start();
}

void boot();
