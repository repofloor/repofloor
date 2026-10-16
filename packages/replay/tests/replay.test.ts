/**
 * The arithmetic behind showing an office at a past moment.
 *
 * Pure, which is why it lives in a package rather than in whichever page asked for it
 * first — the Lite page and the hosted UI both scrub the same way, and two
 * implementations would drift into two answers for "what did this look like then".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyOfficeState, type OfficeEvent, type OfficeState } from "@repofloor/protocol";
import {
  eventsBetween,
  isPublishedHistory,
  presetsFor,
  spanOf,
  stamp,
  stateAt,
  type PublishedHistory,
} from "../src/index.ts";

const OFFICE = "repofloor/repofloor";
const HOUR = 3600_000;

const base: OfficeState = emptyOfficeState(
  { id: "repofloor", name: "repofloor", kind: "organization" },
  { id: OFFICE, buildingId: "repofloor", name: "repofloor", private: false },
  "lite",
);

const push = (id: string, at: string, actorId = "ali"): OfficeEvent => ({
  id,
  at,
  officeId: OFFICE,
  type: "push",
  actorId,
  branch: "main",
  commits: 1,
});

const history = (events: OfficeEvent[], generatedAt = "2026-10-16T12:00:00.000Z"): PublishedHistory => ({
  officeId: OFFICE,
  hours: 72,
  generatedAt,
  events,
});

// ── spans ────────────────────────────────────────────────────────────────────

test("the span covers the events, not the window that was asked for", () => {
  // A young repository has less history than the look-back, and a slider over time
  // nobody has any events for does nothing for most of its travel.
  const h = history([push("a", "2026-10-16T10:00:00.000Z"), push("b", "2026-10-16T11:00:00.000Z")]);
  const span = spanOf(h);

  assert.equal(span.from, Date.parse("2026-10-16T10:00:00.000Z"));
  assert.equal(span.to, Date.parse("2026-10-16T12:00:00.000Z"));
});

test("an empty history falls back to the asked-for window", () => {
  const span = spanOf(history([]));
  assert.equal(span.to - span.from, 72 * HOUR);
});

test("a single event still gives a span a slider can move along", () => {
  // Same moment at both ends would be a control that looks broken.
  const at = "2026-10-16T12:00:00.000Z";
  const span = spanOf(history([push("a", at)], at));
  assert.ok(span.to > span.from, "a zero-width span is a slider that cannot move");
});

// ── the office at a moment ───────────────────────────────────────────────────

test("the state at a moment includes what had happened and nothing after", () => {
  const h = history([
    push("a", "2026-10-16T09:00:00.000Z", "ali"),
    push("b", "2026-10-16T10:00:00.000Z", "ayse"),
    push("c", "2026-10-16T11:00:00.000Z", "mete"),
  ]);

  const at10 = stateAt(h, base, Date.parse("2026-10-16T10:30:00.000Z"));
  assert.deepEqual(at10.actors.map((a) => a.actor.id).sort(), ["ali", "ayse"]);

  const atEnd = stateAt(h, base, Date.parse("2026-10-16T12:00:00.000Z"));
  assert.deepEqual(atEnd.actors.map((a) => a.actor.id).sort(), ["ali", "ayse", "mete"]);
});

test("the moment is exact: an event at the cursor counts, one after does not", () => {
  const h = history([push("a", "2026-10-16T10:00:00.000Z")]);

  assert.equal(stateAt(h, base, Date.parse("2026-10-16T10:00:00.000Z")).actors.length, 1);
  assert.equal(stateAt(h, base, Date.parse("2026-10-16T09:59:59.000Z")).actors.length, 0);
});

test("scrubbing backwards really goes back, rather than accumulating", () => {
  // Built from empty every time on purpose. Applying events to whatever is on screen
  // would make the cursor a one-way trip.
  const h = history([push("a", "2026-10-16T09:00:00.000Z"), push("b", "2026-10-16T11:00:00.000Z", "ayse")]);

  const late = stateAt(h, base, Date.parse("2026-10-16T11:30:00.000Z"));
  const early = stateAt(h, base, Date.parse("2026-10-16T09:30:00.000Z"));

  assert.equal(late.actors.length, 2);
  assert.equal(early.actors.length, 1, "going back must drop what had not happened yet");
});

test("the office keeps its identity at every moment", () => {
  const h = history([push("a", "2026-10-16T09:00:00.000Z")]);
  const at = stateAt(h, base, Date.parse("2026-10-16T09:30:00.000Z"));
  assert.equal(at.office.id, OFFICE);
  assert.equal(at.mode, "lite");
});

// ── what to animate ──────────────────────────────────────────────────────────

test("only what just went past is animated", () => {
  const h = history([
    push("a", "2026-10-16T09:00:00.000Z"),
    push("b", "2026-10-16T10:00:00.000Z"),
    push("c", "2026-10-16T11:00:00.000Z"),
  ]);

  const crossed = eventsBetween(h, Date.parse("2026-10-16T09:30:00.000Z"), Date.parse("2026-10-16T10:30:00.000Z"));
  assert.deepEqual(crossed.map((e) => e.id), ["b"]);
});

test("going backwards animates nothing", () => {
  const h = history([push("a", "2026-10-16T10:00:00.000Z")]);
  assert.deepEqual(eventsBetween(h, Date.parse("2026-10-16T11:00:00.000Z"), Date.parse("2026-10-16T09:00:00.000Z")), []);
});

// ── presets ──────────────────────────────────────────────────────────────────

test("presets longer than the history are not offered", () => {
  // "this week" on an office two hours old is a button that does nothing.
  const twoHours = { from: Date.now() - 2 * HOUR, to: Date.now() };
  const labels = presetsFor(twoHours).map((p) => p.label);

  assert.ok(labels.includes("last hour"));
  assert.ok(!labels.includes("this week"));
  assert.ok(labels.includes("everything"), "everything is always offered");
});

test("a preset never starts before the history does", () => {
  const span = { from: Date.now() - 2 * HOUR, to: Date.now() };
  for (const preset of presetsFor(span)) assert.ok(preset.from >= span.from, preset.label);
});

// ── parsing ──────────────────────────────────────────────────────────────────

test("a published history is shape-checked, because it came off the network", () => {
  assert.equal(isPublishedHistory(history([])), true);
  for (const bad of [null, "a string", {}, { officeId: OFFICE }, { officeId: OFFICE, events: "no" }]) {
    assert.equal(isPublishedHistory(bad), false, JSON.stringify(bad));
  }
});

test("the stamp says a moment a person can check against their own clock", () => {
  const text = stamp(Date.parse("2026-10-16T12:00:00.000Z"));
  assert.ok(text.length > 0);
  assert.ok(/\d/.test(text));
});
