/**
 * The session layer on its own: cookie signing, cookie parsing/serialization, and the
 * in-memory store's lifetime rules. No network, no server.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InMemorySessionStore,
  parseCookies,
  serializeCookie,
  signValue,
  unsignValue,
} from "../src/session.ts";
import { safeReturnTo } from "../src/http.ts";

const SECRET = "cookie-secret-long-enough";

test("a signed value round-trips, and a tampered one does not", () => {
  const signed = signValue(SECRET, "session-id-42");
  assert.equal(unsignValue(SECRET, signed), "session-id-42");

  assert.equal(unsignValue("another-secret", signed), undefined, "a different secret cannot read it");
  assert.equal(unsignValue(SECRET, signed.replace("session-id-42", "session-id-43")), undefined, "value changed");
  assert.equal(unsignValue(SECRET, `${signed}x`), undefined, "signature changed");
  assert.equal(unsignValue(SECRET, "session-id-42"), undefined, "no signature at all");
  assert.equal(unsignValue(SECRET, "session-id-42."), undefined, "empty signature");
  assert.equal(unsignValue(SECRET, ".abc"), undefined, "empty value");
  assert.equal(unsignValue(SECRET, undefined), undefined);
  assert.equal(unsignValue("", signed), undefined, "no secret means nothing verifies");
});

test("a value containing a dot still round-trips", () => {
  // The signature is split off at the *last* dot, so values may contain dots.
  const signed = signValue(SECRET, "a.b.c");
  assert.equal(unsignValue(SECRET, signed), "a.b.c");
});

test("parseCookies reads a header the way a browser sends it", () => {
  assert.deepEqual(parseCookies("rf_session=abc; rf_oauth=def"), { rf_session: "abc", rf_oauth: "def" });
  assert.deepEqual(parseCookies("a=1%2F2"), { a: "1/2" }, "values are percent-decoded");
  assert.deepEqual(parseCookies(["a=1", "b=2"]), { a: "1", b: "2" });
  assert.deepEqual(parseCookies("a=1; a=2"), { a: "1" }, "the first wins");
  assert.deepEqual(parseCookies("broken; =2; a=3"), { a: "3" }, "unparseable pairs are skipped");
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies("a=%E0%A4%A"), { a: "%E0%A4%A" }, "bad encoding is kept raw, not thrown on");
});

test("the session cookie is HttpOnly, SameSite and scoped to the whole site", () => {
  const cookie = serializeCookie("rf_session", "abc.def", {
    maxAge: 3600,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  });
  assert.match(cookie, /^rf_session=abc\.def;/);
  for (const attribute of ["Path=/", "Max-Age=3600", "HttpOnly", "Secure", "SameSite=Lax"]) {
    assert.ok(cookie.includes(attribute), `${attribute} is set`);
  }

  const insecure = serializeCookie("rf_session", "abc", { secure: false });
  assert.ok(!insecure.includes("Secure"), "no Secure over plain http, or the browser would drop it");

  const cleared = serializeCookie("rf_session", "", { maxAge: 0 });
  assert.ok(cleared.includes("Max-Age=0") && cleared.includes("Expires=Thu, 01 Jan 1970"), "clearing is explicit");
});

test("a session is created with an unguessable id and found by it", async () => {
  const sessions = new InMemorySessionStore();
  const session = await sessions.create({ login: "aliosmanmho", userId: 7, token: "gho_alice" });

  assert.ok(session.id.length >= 32, "256 bits, base64url");
  assert.equal((await sessions.get(session.id))?.token, "gho_alice");
  assert.equal(await sessions.get("not-a-session"), undefined);

  const other = await sessions.create({ login: "someone", userId: 8, token: "gho_bob" });
  assert.notEqual(other.id, session.id);
});

test("a session expires, and an expired one is forgotten rather than returned", async () => {
  let clock = 1_000;
  const sessions = new InMemorySessionStore({ ttlMs: 60_000, now: () => clock });
  const session = await sessions.create({ login: "aliosmanmho", userId: 7, token: "gho_alice" });

  clock += 59_000;
  assert.equal((await sessions.get(session.id))?.login, "aliosmanmho");

  clock += 2_000;
  assert.equal(await sessions.get(session.id), undefined);
  assert.equal(sessions.size, 0, "the record is dropped, not just hidden");
});

test("logging out destroys the record, so the cookie is worthless afterwards", async () => {
  const sessions = new InMemorySessionStore();
  const session = await sessions.create({ login: "aliosmanmho", userId: 7, token: "gho_alice" });

  await sessions.destroy(session.id);
  assert.equal(await sessions.get(session.id), undefined);
  await sessions.destroy(session.id); // idempotent
});

test("the store holds at most maxSessions", async () => {
  const sessions = new InMemorySessionStore({ maxSessions: 2 });
  for (const login of ["a", "b", "c", "d"]) await sessions.create({ login, userId: 1, token: `t-${login}` });
  assert.equal(sessions.size, 2);
});

test("safeReturnTo refuses anything that is not a path on our own site", () => {
  assert.equal(safeReturnTo("/office/repofloor/repofloor"), "/office/repofloor/repofloor");
  assert.equal(safeReturnTo("https://evil.example/"), "/", "no open redirect");
  assert.equal(safeReturnTo("//evil.example/"), "/", "protocol-relative is still off-site");
  assert.equal(safeReturnTo("/ok\r\nSet-Cookie: x=1"), "/", "no header injection");
  assert.equal(safeReturnTo(null), "/");
  assert.equal(safeReturnTo("", "/fallback"), "/fallback");
});
