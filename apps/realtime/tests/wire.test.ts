/** The wire format: what we accept off it, and what we refuse to parse. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeClientMessage, officeIdFromPath } from "../src/wire.ts";

test("an office path becomes an office id, percent-encoding included", () => {
  assert.equal(officeIdFromPath("/office/repofloor/repofloor"), "repofloor/repofloor");
  assert.equal(officeIdFromPath("/office/repofloor/repofloor/"), "repofloor/repofloor");
  assert.equal(officeIdFromPath("/office/my-org/my.repo"), "my-org/my.repo");
  assert.equal(officeIdFromPath("/office/a%2Fb/c"), undefined, "an encoded slash is not two segments");
});

test("anything that is not an office path is nothing", () => {
  for (const path of ["/", "/office", "/office/only-owner", "/office/a/b/c", "/offices/a/b", "/healthz"]) {
    assert.equal(officeIdFromPath(path), undefined, path);
  }
});

test("ping is the only thing a client may say", () => {
  assert.deepEqual(decodeClientMessage('{"type":"ping"}'), { type: "ping" });
  assert.equal(decodeClientMessage('{"type":"snapshot"}'), undefined);
  assert.equal(decodeClientMessage("[]"), undefined);
  assert.equal(decodeClientMessage("null"), undefined);
  assert.equal(decodeClientMessage("}{"), undefined);
});

test("an oversized frame is refused before it is parsed", () => {
  const huge = JSON.stringify({ type: "ping", padding: "x".repeat(5_000) });
  assert.equal(decodeClientMessage(huge), undefined);
});
