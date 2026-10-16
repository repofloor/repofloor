/**
 * The history player: a published office, at any moment inside its window.
 *
 * The Lite action publishes `office-events.json` beside the snapshot — the events that
 * produced it, in order (ADR 0003). Given those, showing the office at time T is just
 * `replay(empty, events up to T, T)`, because the reducer is pure and takes its time
 * from `event.at` rather than the clock. Rule 2, written in Phase 0, is what makes this
 * a hundred lines instead of a rewrite.
 *
 * Office-level on purpose: there is no per-person filter here and there must not be
 * one. ADR 0003 decision 1, and rule 6.
 *
 * Replaying from empty on every scrub is O(events). At a published window — a few
 * hundred at most — that is nothing, and it keeps the cursor exact. A full-history
 * player will need checkpoints; this one does not, and pretending otherwise now would
 * be building for a file that does not exist yet.
 */

import { emptyOfficeState, type OfficeEvent, type OfficeState } from "@repofloor/protocol";
import { replay } from "@repofloor/reducer";

export interface PublishedHistory {
  officeId: string;
  /** The look-back window the action collected, in hours. */
  hours: number;
  generatedAt: string;
  events: OfficeEvent[];
}

/** Shape-check a fetched history: it comes off the network like any other input. */
export function isPublishedHistory(value: unknown): value is PublishedHistory {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["officeId"] === "string" && Array.isArray(v["events"]) && typeof v["generatedAt"] === "string";
}

export interface Span {
  from: number;
  to: number;
}

/**
 * The window the events actually cover. The action's `hours` is what it *asked* for;
 * a young repository has less, and a slider over time nobody has any events for is a
 * slider that does nothing for most of its travel.
 */
export function spanOf(history: PublishedHistory): Span {
  const to = Date.parse(history.generatedAt);
  const first = history.events[0];
  const from = first ? Date.parse(first.at) : to - history.hours * 3600_000;
  // A single-event history would give a zero-width span and a slider that cannot move.
  return { from: Math.min(from, to - 60_000), to };
}

/** The office as it stood at `at`, built from scratch so the cursor is exact. */
export function stateAt(history: PublishedHistory, base: OfficeState, at: number): OfficeState {
  const upTo = history.events.filter((e) => Date.parse(e.at) <= at);
  const empty = emptyOfficeState(base.building, base.office, base.mode);
  return replay(empty, upTo, new Date(at).toISOString());
}

/** Events in `(after, at]` — what to animate when the cursor moves forward. */
export function eventsBetween(history: PublishedHistory, after: number, at: number): OfficeEvent[] {
  if (at <= after) return [];
  return history.events.filter((e) => {
    const t = Date.parse(e.at);
    return t > after && t <= at;
  });
}

/** Presets offered under the scrubber, dropped when the window is shorter than they are. */
export const PRESETS: Array<{ label: string; hours: number }> = [
  { label: "last hour", hours: 1 },
  { label: "today", hours: 24 },
  { label: "this week", hours: 24 * 7 },
];

export function presetsFor(span: Span): Array<{ label: string; hours: number; from: number }> {
  const windowHours = (span.to - span.from) / 3600_000;
  const offered = PRESETS.filter((p) => p.hours < windowHours * 1.5).map((p) => ({
    ...p,
    from: Math.max(span.from, span.to - p.hours * 3600_000),
  }));
  return [...offered, { label: "everything", hours: windowHours, from: span.from }];
}

/** `2026-10-16 08:16` in the viewer's own time, which is the only one they can check. */
export function stamp(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
