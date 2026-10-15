import { strict as assert } from "node:assert";
import { test } from "node:test";
import { emptyOfficeState, type OfficeEvent, type OfficeState } from "@repofloor/protocol";
import { describeEvent, stripRows, summarize } from "../src/describe.js";

function office(): OfficeState {
  return emptyOfficeState(
    { id: "repofloor", name: "repofloor", kind: "organization" },
    { id: "repofloor/repofloor", buildingId: "repofloor", name: "repofloor" },
    "full",
  );
}

function withActors(): OfficeState {
  const state = office();
  return {
    ...state,
    rooms: [...state.rooms, { id: "repofloor/repofloor#standup", officeId: state.office.id, kind: "team", name: "Standup" }],
    actors: [
      { actor: { id: "away-person", kind: "human" }, status: "offline", lastSeen: "2026-10-15T09:00:00.000Z" },
      { actor: { id: "ali", kind: "human", name: "Ali", emoji: "🛠" }, status: "coding", lastSeen: "2026-10-15T10:00:00.000Z", detail: "feat/web" },
      { actor: { id: "idle-person", kind: "human" }, status: "idle", lastSeen: "2026-10-15T10:05:00.000Z" },
      {
        actor: { id: "agent:aliosmanmho:claude", kind: "agent", agent: { provider: "claude-code", ownerId: "ali" } },
        status: "in_room",
        roomId: "repofloor/repofloor#standup",
        lastSeen: "2026-10-15T10:06:00.000Z",
      },
    ],
  };
}

test("the strip reads busiest first and away last", () => {
  const rows = stripRows(withActors());
  assert.deepEqual(
    rows.map((r) => r.id),
    ["agent:aliosmanmho:claude", "ali", "idle-person", "away-person"],
  );
});

test("a row is name, emoji and what they are doing", () => {
  const ali = stripRows(withActors()).find((r) => r.id === "ali");
  assert.equal(ali?.name, "Ali");
  assert.equal(ali?.emoji, "🛠");
  assert.equal(ali?.label, "writing code");
  assert.equal(ali?.detail, "feat/web");
});

test("an agent is named by the part of its id people recognise, and says which room", () => {
  const agent = stripRows(withActors()).find((r) => r.kind === "agent");
  assert.equal(agent?.name, "claude");
  assert.equal(agent?.emoji, "🤖");
  assert.equal(agent?.room, "Standup");
});

test("the summary counts people and agents separately, and admits an empty floor", () => {
  assert.equal(summarize(withActors()), "2 people · 1 agent on the floor");
  assert.equal(summarize(office()), "nobody on the floor");
});

test("every event becomes a line somebody can read", () => {
  const base = { id: "e1", at: "2026-10-15T10:00:00.000Z", officeId: "repofloor/repofloor" };
  const state = withActors();
  const cases: Array<[OfficeEvent, string]> = [
    [{ ...base, type: "push", actorId: "ali", branch: "main", commits: 1 }, "pushed 1 commit to main"],
    [{ ...base, type: "push", actorId: "ali", branch: "main", commits: 3 }, "pushed 3 commits to main"],
    [{ ...base, type: "pr.merged", number: 24, actorId: "ali" }, "merged PR #24 🎉"],
    [{ ...base, type: "pr.reviewed", number: 24, reviewerId: "ali", verdict: "changes_requested" }, "requested changes on PR #24"],
    [{ ...base, type: "ci.status", status: "failure", branch: "main" }, "CI on main: failure"],
    [
      { ...base, type: "actor.move", actorId: "ali", roomId: "repofloor/repofloor#standup" },
      "went into Standup",
    ],
    [{ ...base, type: "actor.move", actorId: "ali" }, "came back to their desk"],
    [
      { ...base, type: "agent.tool_call", actorId: "agent:aliosmanmho:claude", call: { at: base.at, tool: "Edit", target: "src/main.ts" } },
      "Edit src/main.ts",
    ],
  ];

  for (const [event, text] of cases) {
    assert.equal(describeEvent(event, state).text, text, event.type);
  }
});

test("a line names the actor the way the strip does", () => {
  const state = withActors();
  const line = describeEvent(
    { id: "e2", at: "2026-10-15T10:00:00.000Z", officeId: "repofloor/repofloor", type: "pr.merged", number: 1, actorId: "ali" },
    state,
  );
  assert.equal(line.who, "Ali");

  // An actor the snapshot has never heard of still reads as something.
  const unknown = describeEvent(
    { id: "e3", at: "2026-10-15T10:00:00.000Z", officeId: "repofloor/repofloor", type: "pr.merged", number: 1, actorId: "agent:x:codex" },
    state,
  );
  assert.equal(unknown.who, "codex");
});

test("an event about the office, not a person, has no actor", () => {
  const line = describeEvent({
    id: "e4",
    at: "2026-10-15T10:00:00.000Z",
    officeId: "repofloor/repofloor",
    type: "pr.closed",
    number: 9,
  });
  assert.equal(line.who, "");
  assert.equal(line.text, "PR #9 closed");
});
