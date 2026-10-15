import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalizeBase, officeApiPath, signInPath, socketUrl } from "../src/endpoints.js";

test("a base loses its trailing slashes", () => {
  assert.equal(normalizeBase("https://repofloor.example/"), "https://repofloor.example");
  assert.equal(normalizeBase(""), "");
});

test("an office id becomes the api path, encoded", () => {
  assert.equal(officeApiPath("repofloor/repofloor"), "/office/repofloor/repofloor");
  assert.equal(officeApiPath("owner/dot.files"), "/office/owner/dot.files");
  assert.throws(() => officeApiPath("nonsense"), /not an office id/);
});

test("with no configured base the socket goes to the page's own origin", () => {
  assert.equal(socketUrl("", "o/r", "https://repofloor.example"), "wss://repofloor.example/office/o/r");
  assert.equal(socketUrl("", "o/r", "http://localhost:5174"), "ws://localhost:5174/office/o/r");
});

test("a configured base may be given as http or ws", () => {
  assert.equal(socketUrl("http://localhost:8788", "o/r", "http://x"), "ws://localhost:8788/office/o/r");
  assert.equal(socketUrl("ws://localhost:8788/", "o/r", "http://x"), "ws://localhost:8788/office/o/r");
  assert.equal(socketUrl("https://live.example", "o/r", "http://x"), "wss://live.example/office/o/r");
  assert.equal(socketUrl("wss://live.example", "o/r", "http://x"), "wss://live.example/office/o/r");
});

test("something that is not an origin is a programming error, not a bad socket", () => {
  assert.throws(() => socketUrl("live.example", "o/r", ""), /not an origin/);
});

test("sign-in carries where to come back to", () => {
  assert.equal(signInPath("/repofloor/repofloor"), "/auth/github?return_to=%2Frepofloor%2Frepofloor");
});
