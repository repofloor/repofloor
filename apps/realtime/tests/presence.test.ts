/**
 * Presence (ADR 0002, decision 3): ephemeral, expressed in events the protocol
 * already has, and careful never to contradict what GitHub said.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "@repofloor/protocol";
import { OfficePresence, isEmptyChange, presenceEvents } from "../src/presence.ts";

const OFFICE = "repofloor/repofloor";
const AT = "2026-10-15T09:00:00.000Z";

const viewer = (login: string): Actor => ({ id: login, kind: "human", name: login });

test("a viewer arrives once, however many tabs they open", () => {
  const presence = new OfficePresence();

  assert.deepEqual(presence.join(viewer("ali")), { arrived: [viewer("ali")], departed: [] });
  assert.equal(isEmptyChange(presence.join(viewer("ali"))), true, "a second tab is not a second person");
  assert.equal(presence.size, 1);

  assert.equal(isEmptyChange(presence.leave("ali")), true, "closing one tab is not leaving");
  assert.deepEqual(presence.leave("ali"), { arrived: [], departed: ["ali"] });
  assert.equal(presence.size, 0);
});

test("leaving someone who was never here is not a change", () => {
  const presence = new OfficePresence();
  assert.equal(isEmptyChange(presence.leave("nobody")), true);
});

test("a viewer we stop hearing from is dropped after the TTL, and touch postpones it", () => {
  let now = 1_000_000;
  const presence = new OfficePresence({ ttlMs: 1_000, now: () => now });
  presence.join(viewer("ali"));

  now += 500;
  assert.equal(isEmptyChange(presence.expire()), true, "still within the TTL");

  presence.touch("ali");
  now += 800;
  assert.equal(isEmptyChange(presence.expire()), true, "touch moved the deadline");

  now += 1_200;
  assert.deepEqual(presence.expire(), { arrived: [], departed: ["ali"] });
  assert.equal(presence.size, 0);
});

test("arrival is actor.upsert and carries no status, so it cannot downgrade anyone", () => {
  const events = presenceEvents(OFFICE, { arrived: [viewer("ali")], departed: [] }, AT, new Set());

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "actor.upsert");
  assert.equal(events[0]?.officeId, OFFICE);
  assert.equal(JSON.stringify(events[0]).includes("status"), false, "upsert must not set a status");
});

test("departure is announced only for a viewer the office does not already know", () => {
  // "ali" pushed a commit, so the snapshot has him; "guest" is only watching.
  const known = new Set(["ali"]);
  const events = presenceEvents(OFFICE, { arrived: [], departed: ["ali", "guest"] }, AT, known);

  assert.equal(events.length, 1, "marking a contributor offline for closing a tab would be a lie");
  assert.equal(events[0]?.type, "actor.leave");
  assert.equal(events[0]?.type === "actor.leave" ? events[0].actorId : undefined, "guest");
});

test("nothing presence records can answer how long someone has been here", () => {
  let now = 1_000;
  const presence = new OfficePresence({ now: () => now });
  presence.join(viewer("ali"));
  now += 60_000;
  presence.touch("ali");

  // The only timestamp is the last sign of life, which moves forward; there is no
  // arrival time anywhere to subtract it from.
  const serialized = JSON.stringify(presence.actors());
  assert.equal(serialized.includes("since"), false);
  assert.equal(serialized.includes("joinedAt"), false);
  assert.deepEqual(presence.actors(), [viewer("ali")]);
});
