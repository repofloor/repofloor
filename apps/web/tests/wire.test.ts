import { strict as assert } from "node:assert";
import { test } from "node:test";
import { emptyOfficeState, PROTOCOL_VERSION } from "@repofloor/protocol";
import { closeMeaning, CLOSE, parseServerMessage } from "../src/wire.js";

const state = emptyOfficeState(
  { id: "repofloor", name: "repofloor", kind: "organization" },
  { id: "repofloor/repofloor", buildingId: "repofloor", name: "repofloor" },
  "full",
);

test("hello carries the office and the protocol version", () => {
  const message = parseServerMessage(
    JSON.stringify({ type: "hello", officeId: "o/r", protocolVersion: PROTOCOL_VERSION, viewer: { login: "ali" } }),
  );
  assert.deepEqual(message, {
    type: "hello",
    officeId: "o/r",
    protocolVersion: PROTOCOL_VERSION,
    viewer: { login: "ali" },
  });
});

test("a viewer without a login is no viewer", () => {
  const message = parseServerMessage(
    JSON.stringify({ type: "hello", officeId: "o/r", protocolVersion: "1.0.0", viewer: { avatarUrl: "x" } }),
  );
  assert.deepEqual(message, { type: "hello", officeId: "o/r", protocolVersion: "1.0.0" });
});

test("a snapshot is validated as an OfficeState before the renderer sees it", () => {
  const ok = parseServerMessage(JSON.stringify({ type: "snapshot", officeId: "o/r", state }));
  assert.equal(ok?.type, "snapshot");
  assert.equal(parseServerMessage(JSON.stringify({ type: "snapshot", officeId: "o/r", state: { nope: 1 } })), undefined);
});

test("a snapshot from a different protocol major is refused, not rendered", () => {
  const future = { ...state, protocolVersion: "2.0.0" };
  assert.equal(parseServerMessage(JSON.stringify({ type: "snapshot", officeId: "o/r", state: future })), undefined);
});

test("events keep the ones that look like events and drop the rest", () => {
  const message = parseServerMessage(
    JSON.stringify({
      type: "events",
      officeId: "o/r",
      events: [
        { id: "1", at: "2026-10-15T10:00:00.000Z", officeId: "o/r", type: "pr.merged", number: 7, actorId: "ali" },
        { type: "pr.merged" },
        "not an event",
      ],
    }),
  );
  assert.equal(message?.type, "events");
  assert.equal(message.type === "events" ? message.events.length : 0, 1);
});

test("a frame type this build does not know is ignored, not thrown", () => {
  assert.equal(parseServerMessage(JSON.stringify({ type: "chat.history", lines: [] })), undefined);
  assert.equal(parseServerMessage("not json"), undefined);
  assert.equal(parseServerMessage("null"), undefined);
  assert.equal(parseServerMessage(JSON.stringify({ type: "events", officeId: "o/r", events: [] })), undefined);
});

test("close codes say whether retrying could ever help", () => {
  assert.equal(closeMeaning(CLOSE.UNAUTHORIZED), "unauthorized");
  assert.equal(closeMeaning(CLOSE.NOT_FOUND), "not_found");
  assert.equal(closeMeaning(CLOSE.UNAVAILABLE), "unavailable");
  assert.equal(closeMeaning(1006), "retry");
  assert.equal(closeMeaning(CLOSE.GOING_AWAY), "retry");
});
