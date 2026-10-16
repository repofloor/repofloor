/**
 * The replay control: an office as it stood, at any moment in its history.
 *
 * The server keeps every event it has ever applied and the backfill reaches back to
 * the first commit (ADR 0003), so this can scrub a repository's whole life. The
 * arithmetic — the span, the state at a moment, the presets — lives in
 * `@repofloor/replay`, shared with the Lite page rather than written twice.
 *
 * Office-level, and the absence is the feature: there is no person to pick, because
 * `officeEvents` has no actor parameter to pass (rule 6).
 *
 * While a replay is running the live path keeps its state and keeps its hands off the
 * screen. A page that yanked you back to "now" mid-scrub would be unusable.
 */

import type { OfficeEvent, OfficeState } from "@repofloor/protocol";
import { eventsBetween, presetsFor, spanOf, stamp, stateAt, type PublishedHistory } from "@repofloor/replay";
import type { ApiClient } from "./api.js";
import { el } from "./dom.js";

/** How often the replay advances while playing. */
const TICK_MS = 50;
/** How long the whole span takes to watch, in seconds. Not a multiplier — see below. */
const DEFAULT_RUN_FOR = 30;

export interface ReplayHandlers {
  /** Show the office at this moment, animating anything that just went past. */
  onFrame(state: OfficeState, animate: OfficeEvent[]): void;
  /** Replay started or ended. While it is running, the live path must not render. */
  onActive(active: boolean): void;
  /** Something to say in the status area. */
  onStatus(text: string): void;
}

export interface ReplayOptions {
  officeId: string;
  api: ApiClient;
  base: OfficeState;
  handlers: ReplayHandlers;
}

export interface ReplayControl {
  /** The control's own element, to put wherever it belongs. */
  root: HTMLElement;
  stop(): void;
}

export function createReplay(opts: ReplayOptions): ReplayControl {
  const { officeId, api, handlers } = opts;

  let history: PublishedHistory | undefined;
  let cursor = 0;
  let playing = false;
  let runFor = DEFAULT_RUN_FOR;
  let timer: number | undefined;

  const openBtn = el("button", { class: "replay__open", type: "button" }, "replay history");
  const panel = el("div", { class: "replay__panel", hidden: true });
  const root = el("div", { class: "replay" }, openBtn, panel);

  const stopPlaying = (): void => {
    playing = false;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const leave = (): void => {
    stopPlaying();
    history = undefined;
    panel.replaceChildren();
    panel.hidden = true;
    openBtn.hidden = false;
    handlers.onActive(false);
  };

  const load = async (): Promise<void> => {
    openBtn.disabled = true;
    openBtn.textContent = "loading history…";
    try {
      const fetched = await api.officeEvents(officeId);
      if (fetched.events.length === 0) {
        handlers.onStatus("no history yet — it arrives as the office is walked back");
        openBtn.textContent = "replay history";
        openBtn.disabled = false;
        return;
      }
      history = {
        officeId,
        hours: 0,
        generatedAt: fetched.events[fetched.events.length - 1]!.at,
        events: fetched.events,
      };
      openBtn.hidden = true;
      panel.hidden = false;
      handlers.onActive(true);
      build(fetched.truncated);
    } catch {
      handlers.onStatus("the history could not be loaded");
      openBtn.textContent = "replay history";
      openBtn.disabled = false;
    }
  };

  function build(truncated: boolean): void {
    const span = spanOf(history!);
    cursor = span.from;

    const readout = el("span", { class: "replay__at" });
    const slider = el("input", {
      class: "replay__scrub",
      type: "range",
      min: String(span.from),
      max: String(span.to),
      step: "1000",
      value: String(cursor),
      "aria-label": "Moment in this office's history",
    }) as HTMLInputElement;
    const playBtn = el("button", { class: "replay__play", type: "button" }, "▶ play");
    const exitBtn = el("button", { class: "replay__exit", type: "button" }, "back to live");

    const atEnd = (): boolean => cursor >= span.to - 1000;

    const show = (animateFrom?: number): void => {
      const animate = animateFrom === undefined ? [] : eventsBetween(history!, animateFrom, cursor);
      handlers.onFrame(stateAt(history!, opts.base, cursor), animate);
      readout.textContent = stamp(cursor);
      slider.value = String(cursor);
    };

    const setCursor = (at: number, animate: boolean): void => {
      const from = cursor;
      cursor = Math.max(span.from, Math.min(span.to, at));
      show(animate && cursor > from ? from : undefined);
    };

    const stop = (): void => {
      stopPlaying();
      playBtn.textContent = "▶ play";
    };

    const start = (): void => {
      if (atEnd()) setCursor(span.from, false);
      playing = true;
      playBtn.textContent = "⏸ pause";
      // Span-relative, not a multiplier: "a minute of history per second" reads
      // sensibly and means a year never finishes. What someone means by play is
      // "show me this, in about a minute".
      const perTick = ((span.to - span.from) / runFor) * (TICK_MS / 1000);
      timer = window.setInterval(() => {
        let next = cursor + perTick;
        // Skip the quiet stretches. A repository is idle most of the time, and
        // watching an empty office at 3am is not what anyone pressed play for.
        const upcoming = history!.events.find((e) => Date.parse(e.at) > cursor);
        if (upcoming) {
          const at = Date.parse(upcoming.at);
          if (at > next + perTick * 2) next = at - perTick;
        }
        setCursor(next, true);
        if (atEnd()) stop();
      }, TICK_MS);
    };

    playBtn.onclick = () => (playing ? stop() : start());
    exitBtn.onclick = leave;
    slider.oninput = () => {
      stop();
      setCursor(Number(slider.value), false);
    };

    const presets = el("div", { class: "replay__presets" });
    for (const preset of presetsFor(span)) {
      const b = el("button", { type: "button" }, preset.label);
      b.onclick = () => {
        stop();
        setCursor(preset.from, false);
        start();
      };
      presets.append(b);
    }

    const speeds = el("div", { class: "replay__speeds" }, "watch in ");
    for (const seconds of [10, 30, 60, 180]) {
      const b = el("button", { type: "button" }, seconds < 60 ? `${seconds}s` : `${seconds / 60}m`);
      b.onclick = () => {
        runFor = seconds;
        if (playing) {
          stop();
          start();
        }
      };
      speeds.append(b);
    }

    panel.replaceChildren(
      el("div", { class: "replay__head" }, readout, exitBtn),
      slider,
      el("div", { class: "replay__buttons" }, playBtn, presets),
      speeds,
      ...(truncated
        ? [el("p", { class: "replay__note" }, "This is as far back as one request reaches. Narrow the span for more.")]
        : []),
    );

    show();
  }

  openBtn.onclick = () => void load();

  return {
    root,
    stop: leave,
  };
}
