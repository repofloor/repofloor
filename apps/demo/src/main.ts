import { OfficeRenderer } from "@repofloor/engine";
import { reduce, decay } from "@repofloor/reducer";
import {
  eventsBetween,
  isPublishedHistory,
  presetsFor,
  spanOf,
  stamp,
  stateAt,
  type PublishedHistory,
} from "@repofloor/replay";
import { assertOfficeState, type OfficeEvent, type OfficeState } from "@repofloor/protocol";
import { initialState, seedEvents, nextEvent } from "./simulator.js";

const host = document.getElementById("office")!;
const logEl = document.getElementById("log")!;
const controls = document.getElementById("controls")!;
const modeEl = document.getElementById("mode")!;
const clockEl = document.getElementById("clock")!;
const titleEl = document.querySelector("header h1")!;

const renderer = new OfficeRenderer({
  onActorClick: (a) => {
    if (a.link) window.open(a.link, "_blank");
  },
});

let state: OfficeState;

function apply(ev: OfficeEvent) {
  state = reduce(state, ev);
  renderer.applyEffect(ev);
  renderer.setState(state);
  log(ev);
}

function log(ev: OfficeEvent) {
  const d = document.createElement("div");
  const who = "actorId" in ev ? ev.actorId : "pr" in ev ? ev.pr.authorId : "reviewerId" in ev ? ev.reviewerId : "";
  const what =
    ev.type === "agent.tool_call" ? `${ev.call.tool} ${ev.call.target ?? ""}` :
    ev.type === "push" ? `${ev.commits} commit(s) → ${ev.branch}` :
    ev.type === "pr.opened" ? `PR #${ev.pr.number} ${ev.pr.title}` :
    ev.type === "pr.reviewed" ? `#${ev.number} ${ev.verdict}` :
    ev.type === "pr.merged" ? `#${ev.number} merged 🎉` :
    ev.type === "ci.status" ? `${ev.branch}: ${ev.status}` :
    ev.type === "chat.message" ? `"${ev.text}"` :
    ev.type === "actor.move" ? (ev.roomId ? `→ ${ev.roomId.split("#")[1]}` : "→ floor") : "";
  d.innerHTML = `<b>${ev.type}</b> ${who ? who.replace(/^agent:[^:]+:/, "🤖") : ""} ${what}`;
  logEl.prepend(d);
  while (logEl.childElementCount > 40) logEl.lastElementChild?.remove();
}

/** How often the published page looks for a newer snapshot, and how often it ages the one it has. */
const LITE_POLL_MS = 15_000;
const LITE_DECAY_MS = 15_000;
/** How often the replay advances while playing. 20fps is plenty for a floor. */
const TICK_MS = 50;
/** Floor between two fetches: visibilitychange can fire in bursts. */
const LITE_MIN_GAP_MS = LITE_POLL_MS / 2;

async function fetchLite(): Promise<OfficeState | null> {
  try {
    // no-cache, not no-store: Pages sends max-age=600 and an ETag, so revalidate every
    // time (never serve a 10-minute-old copy) but let an unchanged poll answer 304.
    const r = await fetch("./office-state.json", { cache: "no-cache" });
    if (!r.ok) return null;
    const json = await r.json();
    assertOfficeState(json);
    return json;
  } catch {
    return null; // offline, or mid-deploy: keep showing what we have
  }
}


/** The events behind a published snapshot, if the action wrote them. */
async function fetchLiteHistory(): Promise<PublishedHistory | null> {
  try {
    const r = await fetch("./office-events.json", { cache: "no-cache" });
    if (!r.ok) return null;
    const json = await r.json();
    return isPublishedHistory(json) ? json : null;
  } catch {
    return null; // an older published page simply has no history file
  }
}

/**
 * Turn the simulator panel into a history player.
 *
 * Returns a function the live path calls when a newer snapshot arrives, so the page
 * stays live while the cursor is at "now" and stops arguing with the viewer the moment
 * they scrub back.
 */
function runHistory(history: PublishedHistory, first: OfficeState): () => boolean {
  const span = spanOf(history);
  let cursor = span.to;
  let playing = false;
  /**
   * How long the whole span should take to watch, in seconds — not a multiplier.
   *
   * Absolute speeds ("a minute of history per second") read sensibly and are useless:
   * at that rate a week takes nearly three hours, and a repository's whole life never
   * finishes. What someone means by "play" is "show me this, in about a minute".
   */
  let runFor = 30;
  let timer: number | undefined;

  controls.innerHTML = "";
  const head = document.querySelector("aside h2");
  if (head) head.textContent = "Replay";

  const readout = document.createElement("div");
  readout.style.cssText = "color:#9aa3b5;font-size:11px;margin-bottom:6px";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(span.from);
  slider.max = String(span.to);
  slider.value = String(cursor);
  slider.step = "1000";
  slider.style.cssText = "width:100%;margin:4px 0";

  const playBtn = document.createElement("button");
  playBtn.textContent = "▶ play"; // set here too: stop() is what labels it, and it has not run yet
  const nowBtn = document.createElement("button");
  nowBtn.textContent = "now";

  const atEnd = () => cursor >= span.to - 1000;

  const render = (animateFrom?: number) => {
    const events = animateFrom === undefined ? [] : eventsBetween(history, animateFrom, cursor);
    state = stateAt(history, first, cursor);
    // Animate what just went past, then settle on the exact state for that moment.
    for (const ev of events) renderer.applyEffect(ev);
    renderer.setState(state);
    renderer.setState(state);

    readout.textContent = atEnd() ? `now · ${stamp(cursor)}` : stamp(cursor);
    modeEl.textContent = atEnd()
      ? `lite · generated ${new Date(history.generatedAt).toLocaleString()}`
      : `replaying · ${history.events.filter((e) => Date.parse(e.at) <= cursor).length}/${history.events.length} events`;

    logEl.innerHTML = "";
    for (const ev of history.events.filter((e) => Date.parse(e.at) <= cursor).slice(-40).reverse()) log(ev);
  };

  const setCursor = (at: number, animate: boolean) => {
    const from = cursor;
    cursor = Math.max(span.from, Math.min(span.to, at));
    slider.value = String(cursor);
    render(animate && cursor > from ? from : undefined);
  };

  const stop = () => {
    playing = false;
    playBtn.textContent = "▶ play";
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const start = () => {
    // Playing from the end means replaying the whole thing, which is what someone
    // pressing play at "now" almost certainly meant.
    if (atEnd()) setCursor(span.from, false);
    playing = true;
    playBtn.textContent = "⏸ pause";
    const perTick = ((span.to - span.from) / runFor) * (TICK_MS / 1000);
    timer = window.setInterval(() => {
      let next = cursor + perTick;
      // Skip the dead hours. A repository is idle most of the time — nights,
      // weekends — and watching an empty office at 3am is not the point. If nothing
      // happens between here and the next event, jump to just before it.
      const upcoming = history.events.find((e) => Date.parse(e.at) > cursor);
      if (upcoming) {
        const at = Date.parse(upcoming.at);
        if (at > next + perTick * 2) next = at - perTick;
      }
      setCursor(next, true);
      if (atEnd()) stop();
    }, TICK_MS);
  };

  playBtn.onclick = () => (playing ? stop() : start());
  nowBtn.onclick = () => {
    stop();
    setCursor(span.to, false);
  };
  slider.oninput = () => {
    stop();
    setCursor(Number(slider.value), false);
  };

  controls.append(readout, slider, playBtn, nowBtn);

  for (const p of presetsFor(span)) {
    const b = document.createElement("button");
    b.textContent = p.label;
    b.onclick = () => {
      stop();
      setCursor(p.from, false);
      start();
    };
    controls.appendChild(b);
  }

  const speeds = document.createElement("div");
  speeds.style.cssText = "margin-top:6px;color:#9aa3b5;font-size:11px";
  speeds.textContent = "watch in ";
  for (const seconds of [10, 30, 60, 180]) {
    const b = document.createElement("button");
    b.textContent = seconds < 60 ? `${seconds}s` : `${seconds / 60}m`;
    b.title = `play the whole span in about ${b.textContent}, skipping the quiet stretches`;
    b.onclick = () => {
      runFor = seconds;
      if (playing) {
        stop();
        start();
      }
    };
    speeds.appendChild(b);
  }
  controls.appendChild(speeds);

  render();

  // The live path asks before replacing what the viewer is looking at: a page that
  // yanked you back to "now" mid-scrub would be unusable.
  return () => atEnd() && !playing;
}

/**
 * Lite has no event stream, so the page polls its own snapshot. The renderer diffs by
 * actor id, so a newer snapshot makes people walk to their new desk or room instead of
 * teleporting; between snapshots we re-run decay so an open tab still goes quiet.
 */
function runLite(first: OfficeState, isLive: () => boolean = () => true) {
  let snapshot = first;
  const show = () => {
    // While someone is scrubbing, the live path keeps its snapshot current and its
    // hands off the screen.
    if (!isLive()) return;
    state = decay(snapshot, new Date().toISOString());
    renderer.setState(state);
  };
  show();
  setInterval(show, LITE_DECAY_MS);

  let inFlight = false;
  let lastPoll = 0;
  const poll = async () => {
    if (document.hidden || inFlight) return; // a background tab costs nothing
    const now = Date.now();
    if (now - lastPoll < LITE_MIN_GAP_MS) return;
    lastPoll = now;
    inFlight = true;
    try {
      const next = await fetchLite();
      if (!next || next.generatedAt === snapshot.generatedAt) return;
      if (isLive()) celebrateMerges(snapshot, next);
      snapshot = next;
      if (isLive()) modeEl.textContent = `lite · generated ${new Date(next.generatedAt).toLocaleString()}`;
      show();
    } finally {
      inFlight = false;
    }
  };
  setInterval(() => void poll(), LITE_POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void poll();
  });
}

/** The snapshot carries no events, but "celebrating" appearing on someone is a merge. */
function celebrateMerges(prev: OfficeState, next: OfficeState) {
  const before = new Map(prev.actors.map((a) => [a.actor.id, a.status]));
  for (const a of next.actors) {
    if (a.status === "celebrating" && before.get(a.actor.id) !== "celebrating") {
      renderer.applyEffect({
        id: `merge:${a.actor.id}:${next.generatedAt}`,
        at: next.generatedAt,
        officeId: next.office.id,
        type: "pr.merged",
        number: 0,
        actorId: a.actor.id,
      });
    }
  }
}

async function boot() {
  // Lite mode: if ./office-state.json exists next to the page, use it and stop simulating.
  const lite = await fetchLite();
  if (lite) {
    // Shape the page before mounting, so the canvas is sized for the final layout.
    //
    // The simulator's buttons always go: they drive a simulator that is not running.
    // The panel only goes if there is no history to put in it — an older published
    // page, or one from an action that predates office-events.json.
    const history = await fetchLiteHistory();
    if (!history || history.events.length === 0) {
      document.querySelector("aside")?.remove();
      (document.querySelector("main") as HTMLElement | null)?.style.setProperty("grid-template-columns", "1fr");
    }
    // one published page per repository: say which one, in the header and the tab
    titleEl.textContent = `🏢 ${lite.office.id}`;
    document.title = `${lite.office.id} · Repofloor office`;
    modeEl.textContent = `lite · generated ${new Date(lite.generatedAt).toLocaleString()}`;

    await renderer.mount(host);
    const isLive = history && history.events.length > 0 ? runHistory(history, lite) : undefined;
    runLite(lite, isLive);
    return;
  }

  await renderer.mount(host);

  state = initialState();
  for (const ev of seedEvents()) apply(ev);

  // simulated stream
  let paused = false;
  const tickSim = () => {
    if (!paused) apply(nextEvent(state));
    setTimeout(tickSim, 1200 + Math.random() * 2200);
  };
  setTimeout(tickSim, 1500);
  setInterval(() => {
    state = decay(state, new Date().toISOString());
    renderer.setState(state);
  }, 10_000);

  const btn = (label: string, fn: () => OfficeEvent | null) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => {
      const ev = fn();
      if (ev) apply(ev);
    };
    controls.appendChild(b);
  };
  const base = () => ({ id: `ui-${Date.now()}`, at: new Date().toISOString(), officeId: state.office.id });
  btn("🎉 merge a PR", () => (state.pullRequests[0] ? { ...base(), type: "pr.merged", number: state.pullRequests[0].number, actorId: state.pullRequests[0].authorId } : null));
  btn("🔴 CI fails", () => ({ ...base(), type: "ci.status", status: "failure", branch: "main", actorId: "mehmet-k" }));
  btn("🟢 CI green", () => ({ ...base(), type: "ci.status", status: "success", branch: "main" }));
  btn("🤖 agent edit", () => ({ ...base(), type: "agent.tool_call", actorId: "agent:aliosmanmho:claude", call: { at: new Date().toISOString(), tool: "Edit", target: "src/renderer.ts" } }));
  btn("💬 standup", () => ({ ...base(), type: "actor.move", actorId: "aliosmanmho", roomId: `${state.office.id}#standup` }));
  btn("🎧 focus", () => ({ ...base(), type: "actor.move", actorId: "aliosmanmho", roomId: `${state.office.id}#focus` }));
  btn("🚪 back to desk", () => ({ ...base(), type: "actor.move", actorId: "aliosmanmho" }));
  const p = document.createElement("button");
  p.textContent = "⏸ pause sim";
  p.onclick = () => { paused = !paused; p.textContent = paused ? "▶ resume sim" : "⏸ pause sim"; };
  controls.appendChild(p);

  setInterval(() => (clockEl.textContent = new Date().toLocaleTimeString()), 1000);
}

boot().catch((e) => {
  console.error(e);
  host.textContent = String(e);
});
