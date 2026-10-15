/**
 * C3, second half: one building's offices.
 *
 * Filtered out of the same `GET /offices` the buildings page uses. A building that is
 * not in the listing is not an error: it may be private, or it may not exist, and this
 * page can tell the two apart no better than the api can (rule 6).
 */

import { el } from "../dom.js";
import { signInPath } from "../endpoints.js";
import { routePath } from "../route.js";
import { header, officeCard, partialNotice, type View, type ViewContext } from "./buildings.js";
import { empty, failure, onRetry, skeleton } from "./states.js";

export function renderBuilding(ctx: ViewContext, owner: string): View {
  const head = (): HTMLElement =>
    el(
      "div",
      {},
      el(
        "nav",
        { class: "crumbs", "aria-label": "Breadcrumb" },
        el("a", { href: routePath({ kind: "home" }) }, "Buildings"),
        el("span", { "aria-hidden": "true" }, " / "),
        el("span", { text: owner }),
      ),
      header(owner, "One office per repository the App can see in this building."),
    );

  ctx.mount.replaceChildren(head(), skeleton(3));

  let cancelled = false;
  const load = (): void => {
    void ctx.api.offices().then(
      (listing) => {
        if (cancelled) return;
        const here = listing.offices.filter((office) => office.buildingId === owner);
        const nodes: Node[] = [head()];
        if (listing.partial) nodes.push(partialNotice());
        if (here.length > 0) {
          nodes.push(
            el("ul", { class: "cards" }, ...here.sort((a, b) => a.name.localeCompare(b.name)).map(officeCard)),
          );
        } else {
          nodes.push(ctx.viewer ? emptyForViewer(owner, ctx.viewer.login) : emptyForStranger(owner, ctx.returnTo));
        }
        ctx.mount.replaceChildren(...nodes);
      },
      (err: unknown) => {
        if (cancelled) return;
        const node = failure(err, { returnTo: ctx.returnTo, what: `The offices in ${owner}` });
        onRetry(node, load);
        ctx.mount.replaceChildren(head(), node);
      },
    );
  };
  load();

  return {
    dispose: () => {
      cancelled = true;
    },
  };
}

function emptyForViewer(owner: string, login: string): HTMLElement {
  return empty({
    title: `No office in ${owner}`,
    body:
      `Signed in as ${login}, Repofloor sees nothing here. Either the App is not installed on a ` +
      `repository of ${owner}, or nothing has happened in one yet, or this is not a building your ` +
      "GitHub account can see.",
    action: { label: "Install the App", href: "/auth/install", external: true },
  });
}

function emptyForStranger(owner: string, returnTo: string): HTMLElement {
  return empty({
    title: `Nothing public in ${owner}`,
    body:
      "There is no public office here. If this building has private ones, signing in with a GitHub " +
      "account that can read them shows them — Repofloor asks GitHub each time rather than keeping a " +
      "list of its own.",
    action: { label: "Sign in with GitHub", href: signInPath(returnTo), external: true },
  });
}
