/**
 * Connect authorization is delegated to `apps/api` (ADR 0002). These tests pin the
 * two things that make that safe: the client's own credentials are forwarded and
 * nothing else, and anything other than a clear yes is a no.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { emptyOfficeState, type OfficeState } from "@repofloor/protocol";
import { ApiConnectAuthorizer, forwardedCredentials } from "../src/access.ts";

const OFFICE = "repofloor/repofloor";
const API = "http://api.internal:8787";

const state = (): OfficeState =>
  emptyOfficeState(
    { id: "repofloor", name: "repofloor", kind: "organization" },
    { id: OFFICE, buildingId: "repofloor", name: "repofloor", private: true },
    "full",
  );

const req = (headers: Record<string, string> = {}): IncomingMessage => ({ headers }) as IncomingMessage;

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fetch that answers from a table of url suffix → response. */
function fakeFetch(routes: Record<string, { status: number; body?: unknown }>, calls: Call[] = []) {
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const match = Object.keys(routes).find((suffix) => url.endsWith(suffix));
    const route = match ? routes[match]! : { status: 404 };
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("a 200 admits the socket and hands back the snapshot it already fetched", async () => {
  const { impl, calls } = fakeFetch({ "/office/repofloor/repofloor": { status: 200, body: state() } });
  const authorizer = new ApiConnectAuthorizer({ apiUrl: API, fetchImpl: impl });

  const decision = await authorizer.authorize(OFFICE, req({ authorization: "Bearer gho_alice" }));

  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed && decision.state.office.id, OFFICE);
  assert.equal(calls[0]?.url, `${API}/office/repofloor/repofloor`);
  assert.equal(calls.length, 1, "no cookie, so no identity call");
});

test("the api's answers map straight through, and nothing else is a yes", async () => {
  for (const [status, reason] of [
    [401, "unauthenticated"],
    [404, "not_found"],
    [500, "unavailable"],
    [502, "unavailable"],
  ] as const) {
    const { impl } = fakeFetch({ "/office/repofloor/repofloor": { status } });
    const decision = await new ApiConnectAuthorizer({ apiUrl: API, fetchImpl: impl }).authorize(OFFICE, req());
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.reason, reason);
  }
});

test("an unreachable api refuses the socket instead of failing open", async () => {
  const impl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;

  const decision = await new ApiConnectAuthorizer({ apiUrl: API, fetchImpl: impl }).authorize(OFFICE, req());
  assert.deepEqual(decision, { allowed: false, reason: "unavailable" });
});

test("a 200 whose body is not a snapshot is not admitted", async () => {
  const impl = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
  const decision = await new ApiConnectAuthorizer({ apiUrl: API, fetchImpl: impl }).authorize(OFFICE, req());
  assert.deepEqual(decision, { allowed: false, reason: "unavailable" });
});

test("a signed-in browser is identified through /auth/me, with its cookie", async () => {
  const { impl, calls } = fakeFetch({
    "/office/repofloor/repofloor": { status: 200, body: state() },
    "/auth/me": { status: 200, body: { login: "ali", avatarUrl: "https://example.test/a.png" } },
  });

  const decision = await new ApiConnectAuthorizer({ apiUrl: API, fetchImpl: impl }).authorize(
    OFFICE,
    req({ cookie: "rf_session=abc" }),
  );

  assert.equal(decision.allowed && decision.viewer?.login, "ali");
  assert.equal(decision.allowed && decision.viewer?.avatarUrl, "https://example.test/a.png");
  assert.equal(calls[1]?.headers["cookie"], "rf_session=abc");
});

test("a failed identity call costs the viewer their name, not their socket", async () => {
  const { impl } = fakeFetch({
    "/office/repofloor/repofloor": { status: 200, body: state() },
    "/auth/me": { status: 401 },
  });

  const decision = await new ApiConnectAuthorizer({ apiUrl: API, fetchImpl: impl }).authorize(
    OFFICE,
    req({ cookie: "rf_session=stale" }),
  );

  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed && decision.viewer, undefined);
});

test("only the caller's own credentials are forwarded", () => {
  const headers = forwardedCredentials(
    req({
      authorization: "Bearer gho_alice",
      cookie: "rf_session=abc",
      host: "evil.example",
      origin: "https://evil.example",
      "x-forwarded-for": "10.0.0.1",
      "x-github-event": "push",
    }),
  );

  assert.deepEqual(Object.keys(headers).sort(), ["accept", "authorization", "cookie"]);
});

test("a malformed office id never becomes a request", async () => {
  const { impl, calls } = fakeFetch({});
  const authorizer = new ApiConnectAuthorizer({ apiUrl: API, fetchImpl: impl });

  assert.deepEqual(await authorizer.authorize("nope", req()), { allowed: false, reason: "not_found" });
  assert.equal(calls.length, 0);
});

test("the api url is used as given, trailing slash or not", async () => {
  const { impl, calls } = fakeFetch({ "/office/repofloor/repofloor": { status: 200, body: state() } });
  await new ApiConnectAuthorizer({ apiUrl: `${API}///`, fetchImpl: impl }).authorize(OFFICE, req());
  assert.equal(calls[0]?.url, `${API}/office/repofloor/repofloor`);
});
