/**
 * The office page: C1 (the engine against `GET /office/:owner/:repo`) and C4 (the same
 * canvas fed by the 2B socket), plus the two cheapest items of `docs/VISUAL_TARGET.md`
 * — the per-actor status strip and the activity log beside the canvas.
 *
 * The shape is `apps/demo`'s, deliberately: mount the renderer once, push `OfficeState`
 * into `setState`, push `OfficeEvent` into `applyEffect`, and age the state locally
 * between arrivals with `decay`. What differs is only where the state comes from, which
 * is the whole of rule 1 — the renderer below cannot tell a snapshot fetched over HTTP
 * from one that arrived on a socket, and nothing in this file lets it.
 *
 * Local reduction is needed, not optional: the server sends `events` frames having
 * already applied them to its own snapshot, so the strip and the log would drift from
 * the canvas if this page did not run the same pure `reduce` over them.
 */

import { OfficeRenderer } from "@repofloor/engine";
import type { ActivityStatus, OfficeEvent, OfficeState } from "@repofloor/protocol";
import { decay, reduce } from "@repofloor/reducer";
import { ApiError } from "../api.js";
import { REALTIME_URL } from "../config.js";
import { ago, clockText, el } from "../dom.js";
import { describeEvent, stripRows, summarize, type LogLine, type StripRow } from "../describe.js";
import { OfficeLive, type LiveStatus } from "../live.js";
import { routePath } from "../route.js";
import type { View, ViewContext } from "./buildings.js";
import { failure, onRetry, skeleton } from "./states.js";

/** How often local state is aged, so an untouched floor goes quiet on its own. */
const DECAY_MS = 15_000;
/** Lines kept in the activity log. Enough to scroll, not enough to leak memory. */
const LOG_LIMIT = 60;

export function renderOffice(ctx: ViewContext, owner: string, repo: string): View {
  const officeId = `${owner}/${repo}`;
  const what = `The office ${officeId}`;

  let disposed = false;
  let renderer: OfficeRenderer | null = null;
  let live: OfficeLive | null = null;
  let decayTimer: ReturnType<typeof setInterval> | null = null;
  let clockTimer: ReturnType<typeof setInterval> | null = null;
  let state: OfficeState | null = null;

  const dispose = (): void => {
    disposed = true;
    live?.stop();
    live = null;
    if (decayTimer !== null) clearInterval(decayTimer);
    if (clockTimer !== null) clearInterval(clockTimer);
    document.removeEventListener("visibilitychange", onVisible);
    renderer?.destroy();
    renderer = null;
  };

  function onVisible(): void {
    if (!document.hidden) live?.reconnectNow();
  }

  const frame = buildFrame(officeId, owner, repo);
  ctx.mount.replaceChildren(frame.root);
  frame.strip.replaceChildren(skeleton(4));

  const load = (): void => {
    void ctx.api.office(officeId).then(
      async (initial) => {
        if (disposed) return;
        state = initial;
        document.title = `${officeId} · Repofloor`;
        frame.title.textContent = initial.office.name;
        frame.blurb.textContent = initial.office.description ?? summarize(initial);

        renderer = new OfficeRenderer({
          onActorClick: (actor) => {
            // The engine knows nothing about routes: a link is a link.
            if (actor.link) window.open(actor.link, "_blank", "noopener");
          },
        });
        await renderer.mount(frame.canvas);
        if (disposed) {
          renderer.destroy();
          renderer = null;
          return;
        }
        push(initial);

        decayTimer = setInterval(() => {
          if (!state) return;
          push(decay(state, new Date().toISOString()));
        }, DECAY_MS);
        clockTimer = setInterval(() => (frame.clock.textContent = clockText()), 1000);
        frame.clock.textContent = clockText();

        startLive();
        document.addEventListener("visibilitychange", onVisible);
      },
      (err: unknown) => {
        if (disposed) return;
        // No floor to show, so the canvas, the strip and the "drag to pan" line all go:
        // a dark empty box with instructions for using it is a worse answer than none.
        const node = failure(err, { returnTo: ctx.returnTo, what });
        onRetry(node, load);
        frame.blurb.textContent = "This office could not be loaded.";
        frame.body.className = "floor__body floor__body--alone";
        frame.body.replaceChildren(node);
        frame.live.replaceChildren(statusPill({ kind: "refused", reason: reasonOf(err) }));
      },
    );
  };

  /** One place where state becomes pixels and text, so the three can never disagree. */
  function push(next: OfficeState): void {
    state = next;
    renderer?.setState(next);
    frame.strip.replaceChildren(stripList(stripRows(next)));
    frame.snapshot.textContent = `snapshot ${ago(next.generatedAt)}`;
    frame.count.textContent = summarize(next);
  }

  function startLive(): void {
    live = new OfficeLive({
      officeId,
      base: REALTIME_URL,
      handlers: {
        onSnapshot: (next) => {
          // "Replace what you have": a snapshot can arrive at any time, and it is the
          // server telling us our events are no longer a complete story.
          push(next);
          appendLog({ id: `resync:${next.generatedAt}`, at: next.generatedAt, who: "", text: "office resynced", link: undefined });
        },
        onEvents: (events) => {
          for (const event of events) {
            if (state) state = reduce(state, event);
            renderer?.applyEffect(event);
            appendLog(describeEvent(event, state ?? undefined));
          }
          if (state) push(state);
        },
        onStatus: (status) => {
          frame.live.replaceChildren(statusPill(status));
        },
      },
    });
    live.start();
  }

  function appendLog(line: LogLine): void {
    if (frame.log.firstElementChild?.getAttribute("data-empty") !== null) frame.log.replaceChildren();
    frame.log.prepend(logItem(line));
    while (frame.log.childElementCount > LOG_LIMIT) frame.log.lastElementChild?.remove();
  }

  load();
  return { dispose };
}

interface Frame {
  root: HTMLElement;
  canvas: HTMLElement;
  body: HTMLElement;
  side: HTMLElement;
  strip: HTMLElement;
  log: HTMLElement;
  live: HTMLElement;
  snapshot: HTMLElement;
  count: HTMLElement;
  clock: HTMLElement;
  title: HTMLElement;
  blurb: HTMLElement;
}

function buildFrame(officeId: string, owner: string, repo: string): Frame {
  const canvas = el("div", { id: "office", class: "floor__canvas" });
  const strip = el("ul", { class: "strip", "aria-label": "Who is on the floor" });
  const log = el("ol", { class: "log", "aria-label": "Recent activity", "aria-live": "polite" }, emptyLog());
  const liveSlot = el("span", { class: "live" }, statusPill({ kind: "connecting" }));
  const snapshot = el("span", { class: "bar__item" });
  const count = el("span", { class: "bar__item" });
  const clock = el("span", { class: "bar__item bar__item--dim" });
  const title = el("h1", { class: "page-head__title", text: repo });
  const blurb = el("p", { class: "page-head__blurb", text: "Loading the floor…" });

  const side = el(
    "aside",
    { class: "floor__side" },
    el("h2", { class: "floor__heading", id: "strip-heading" }, "On the floor"),
    el(
      "p",
      { class: "floor__hint" },
      "Everyone the office knows about, busiest first. This list is the office in words — it says the " +
        "same thing as the canvas.",
    ),
    strip,
    el("h2", { class: "floor__heading" }, "Activity"),
    el("p", { class: "floor__hint" }, "What GitHub has reported, newest first. An empty log means nothing has happened."),
    log,
  );

  const body = el(
    "div",
    { class: "floor__body" },
    el(
      "div",
      { class: "floor__stage" },
      canvas,
      // Item 6 of the visual target: we have had pan and zoom all along and told nobody.
      el("p", { class: "floor__affordance" }, "Click a person to open what they are working on · drag to pan · scroll to zoom"),
    ),
    side,
  );

  const root = el(
    "div",
    { class: "floor" },
    el(
      "div",
      { class: "floor__head" },
      el(
        "nav",
        { class: "crumbs", "aria-label": "Breadcrumb" },
        el("a", { href: routePath({ kind: "home" }) }, "Buildings"),
        el("span", { "aria-hidden": "true" }, " / "),
        el("a", { href: routePath({ kind: "building", owner }) }, owner),
        el("span", { "aria-hidden": "true" }, " / "),
        el("span", { text: repo }),
      ),
      el("div", { class: "page-head" }, title, blurb),
      el(
        "div",
        { class: "bar" },
        liveSlot,
        count,
        snapshot,
        clock,
        el(
          "a",
          { class: "bar__item bar__item--dim", href: `https://github.com/${officeId}`, target: "_blank", rel: "noopener" },
          "open on GitHub ↗",
        ),
      ),
    ),
    body,
  );

  return { root, canvas, body, side, strip, log, live: liveSlot, snapshot, count, clock, title, blurb };
}

function stripList(rows: StripRow[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (rows.length === 0) {
    fragment.append(
      el("li", { class: "strip__empty", "data-empty": true }, "Nobody yet. An actor appears with their first event."),
    );
    return fragment;
  }
  for (const row of rows) fragment.append(stripItem(row));
  return fragment;
}

function stripItem(row: StripRow): HTMLElement {
  const name = row.link
    ? el("a", { class: "strip__name", href: row.link, target: "_blank", rel: "noopener" }, row.name)
    : el("span", { class: "strip__name", text: row.name });

  return el(
    "li",
    { class: `strip__row strip__row--${statusClass(row.status)}`, "data-kind": row.kind },
    el("span", { class: "strip__icon", "aria-hidden": "true" }, `${row.emoji || row.icon}`),
    el(
      "span",
      { class: "strip__who" },
      name,
      row.kind === "agent" ? el("span", { class: "tag", text: "agent" }) : null,
    ),
    el(
      "span",
      { class: "strip__what" },
      row.label,
      row.room ? el("span", { class: "strip__room", text: ` in ${row.room}` }) : null,
      row.detail ? el("span", { class: "strip__detail", text: ` · ${row.detail}` }) : null,
    ),
  );
}

function logItem(line: LogLine): HTMLElement {
  const time = el("time", { class: "log__at", datetime: line.at, title: new Date(line.at).toLocaleString() }, ago(line.at));
  const text = line.link
    ? el("a", { class: "log__text", href: line.link, target: "_blank", rel: "noopener" }, line.text)
    : el("span", { class: "log__text", text: line.text });
  return el(
    "li",
    { class: "log__line" },
    time,
    // Who and what share one cell: two cells would wrap the text under the timestamp.
    el("span", { class: "log__said" }, line.who ? el("b", { class: "log__who", text: line.who }) : null, text),
  );
}

function emptyLog(): HTMLElement {
  return el("li", { class: "log__empty", "data-empty": true }, "Nothing has happened since this page opened.");
}

/**
 * The live indicator, which is also the only place the socket's state is visible.
 * A refusal says what to do about it; "reconnecting" says when, because a spinner
 * that never resolves is worse than a number.
 */
function statusPill(status: LiveStatus): HTMLElement {
  switch (status.kind) {
    case "connecting":
      return pill("connecting", "connecting…", "Opening the live connection. The snapshot above is already current.");
    case "live":
      return pill(
        "live",
        status.viewer ? `live · you are ${status.viewer.login}` : "live",
        status.viewer
          ? "Connected. Others watching this office can see that you are here, and nothing about how long."
          : "Connected. You are watching anonymously, so nobody is told you are here.",
      );
    case "reconnecting":
      return pill("retry", `reconnecting in ${Math.round(status.inMs / 1000)}s`, "The live connection dropped. The page keeps showing the last state it has.");
    case "refused":
      return pill(
        "off",
        status.reason === "unavailable" ? "live unavailable" : "not live",
        status.reason === "unauthorized"
          ? "The live service would not let this page in. Signing in is the only thing that changes that."
          : status.reason === "not_found"
            ? "There is no live channel for this office — or none you may join."
            : "The live service could not be reached. The snapshot still loads over HTTP.",
      );
  }
}

function pill(tone: string, label: string, help: string): HTMLElement {
  return el(
    "span",
    { class: `pill pill--${tone}`, title: help, "aria-label": `${label}. ${help}` },
    el("span", { class: "pill__dot", "aria-hidden": "true" }),
    label,
  );
}

/** Three visual buckets, so the strip does not need ten colours. */
function statusClass(status: ActivityStatus): "away" | "idle" | "busy" {
  if (status === "offline") return "away";
  if (status === "idle") return "idle";
  return "busy";
}

function reasonOf(err: unknown): "unauthorized" | "not_found" | "unavailable" {
  if (err instanceof ApiError && err.kind === "unauthenticated") return "unauthorized";
  if (err instanceof ApiError && err.kind === "not_found") return "not_found";
  return "unavailable";
}
