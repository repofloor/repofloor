/**
 * C3, first half: every building this viewer may see.
 *
 * One `GET /offices` feeds both this page and the building page below it — the api
 * returns summaries, grouped here by `buildingId`, rather than a second route per
 * level. `partial` is rendered as a notice: an office the api could not ask GitHub
 * about is missing from the list, and a short list that looks complete is worse than
 * a short list that admits it.
 */

import type { ApiClient, OfficeListing, OfficeSummary, Viewer } from "../api.js";
import { ago, el } from "../dom.js";
import { signInPath } from "../endpoints.js";
import { officePagePath, routePath } from "../route.js";
import { empty, failure, onRetry, skeleton } from "./states.js";

export interface ViewContext {
  api: ApiClient;
  viewer: Viewer | null;
  mount: HTMLElement;
  /** Where sign-in should send the browser back to. */
  returnTo: string;
}

export interface View {
  dispose: () => void;
}

const BLURB = "Every GitHub owner with an office Repofloor can show you.";

export function renderBuildings(ctx: ViewContext): View {
  ctx.mount.replaceChildren(header("Buildings", BLURB), skeleton(4));

  let cancelled = false;
  const load = (): void => {
    void ctx.api.offices().then(
      (listing) => {
        if (cancelled) return;
        ctx.mount.replaceChildren(header("Buildings", BLURB), ...body(listing, ctx));
      },
      (err: unknown) => {
        if (cancelled) return;
        const node = failure(err, { returnTo: ctx.returnTo, what: "The list of buildings" });
        onRetry(node, load);
        ctx.mount.replaceChildren(header("Buildings", BLURB), node);
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

function body(listing: OfficeListing, ctx: ViewContext): Node[] {
  const nodes: Node[] = [];
  if (listing.partial) nodes.push(partialNotice());

  if (listing.offices.length === 0) {
    nodes.push(ctx.viewer ? nothingYet(ctx.viewer.login) : nothingPublic(ctx.returnTo));
    return nodes;
  }

  const byBuilding = new Map<string, OfficeSummary[]>();
  for (const office of listing.offices) {
    const existing = byBuilding.get(office.buildingId);
    if (existing) existing.push(office);
    else byBuilding.set(office.buildingId, [office]);
  }

  nodes.push(
    el(
      "ul",
      { class: "cards" },
      ...[...byBuilding.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([buildingId, offices]) => buildingCard(buildingId, offices)),
    ),
  );
  return nodes;
}

function nothingYet(login: string): HTMLElement {
  return empty({
    title: "No offices yet",
    body:
      `Signed in as ${login}. Repofloor can see no office you have access to: either the App is not ` +
      "installed on any of your repositories, or it is installed and no webhook has arrived yet. An " +
      "office appears with its first push, pull request or CI run.",
    action: {
      label: "Install the App",
      href: "/auth/install",
      external: true,
      hint: "Opens GitHub, where you choose which repositories it may see.",
    },
  });
}

function nothingPublic(returnTo: string): HTMLElement {
  return empty({
    title: "Nothing public to show",
    body:
      "There is no public office here, and Repofloor cannot know what else you may read until GitHub " +
      "tells it. Signing in shows the private offices your GitHub account already has access to — it " +
      "grants nothing new.",
    action: {
      label: "Sign in with GitHub",
      href: signInPath(returnTo),
      external: true,
      hint: "Repofloor mirrors your GitHub permissions and keeps no access list of its own.",
    },
  });
}

function buildingCard(buildingId: string, offices: OfficeSummary[]): HTMLElement {
  const people = offices.reduce((sum, office) => sum + office.actors, 0);
  const newest = offices.reduce((latest, office) => (office.generatedAt > latest ? office.generatedAt : latest), "");
  return el(
    "li",
    { class: "card" },
    el(
      "a",
      { class: "card__link", href: routePath({ kind: "building", owner: buildingId }) },
      el("span", { class: "card__glyph", "aria-hidden": "true" }, "\u{1F3E2}"),
      el("span", { class: "card__title", text: buildingId }),
    ),
    el("p", { class: "card__meta", text: `${plural(offices.length, "office")} · ${people} at desks` }),
    newest ? el("p", { class: "card__meta card__meta--dim", text: `updated ${ago(newest)}` }) : null,
  );
}

/** Used by the building page too: one office, as a card. */
export function officeCard(office: OfficeSummary): HTMLElement {
  const visibility = office.private === false ? "public" : "private";
  return el(
    "li",
    { class: "card" },
    el(
      "a",
      { class: "card__link", href: officePagePath(office.officeId) },
      el("span", { class: "card__glyph", "aria-hidden": "true" }, office.private === false ? "\u{1F6AA}" : "\u{1F512}"),
      el("span", { class: "card__title", text: office.name }),
    ),
    el("p", { class: "card__meta", text: `${plural(office.actors, "person", "people")} · ${visibility}` }),
    el("p", { class: "card__meta card__meta--dim", text: `snapshot ${ago(office.generatedAt)}` }),
  );
}

export function partialNotice(): HTMLElement {
  return el(
    "p",
    { class: "notice", role: "status" },
    "This list is incomplete. Repofloor could not reach GitHub to check at least one office, so it " +
      "left it out rather than guess — it is not that you lack access. Reload in a moment.",
  );
}

export function header(title: string, blurb: string): HTMLElement {
  return el(
    "div",
    { class: "page-head" },
    el("h1", { class: "page-head__title", text: title }),
    el("p", { class: "page-head__blurb", text: blurb }),
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
