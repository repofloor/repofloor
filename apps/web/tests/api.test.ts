import { strict as assert } from "node:assert";
import { test } from "node:test";
import { emptyOfficeState } from "@repofloor/protocol";
import { ApiClient, ApiError, failureFor } from "../src/api.js";

const state = emptyOfficeState(
  { id: "repofloor", name: "repofloor", kind: "organization" },
  { id: "repofloor/repofloor", buildingId: "repofloor", name: "repofloor" },
  "full",
);

function respond(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Records what was asked for, answers from a table. */
function stubFetch(table: Record<string, () => Response>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const answer = table[url];
    if (!answer) throw new TypeError("fetch failed");
    return answer();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("status codes map to what the page can do about them", () => {
  assert.equal(failureFor(401), "unauthenticated");
  assert.equal(failureFor(404), "not_found");
  // A 403 is told as a 404 would be: the api refuses to distinguish them, and so do we.
  assert.equal(failureFor(403), "not_found");
  assert.equal(failureFor(503), "unavailable");
  assert.equal(failureFor(500), "unavailable");
});

test("being anonymous is not an error", async () => {
  const { fetchImpl } = stubFetch({ "/auth/me": () => respond(401, { error: "unauthenticated" }) });
  assert.equal(await new ApiClient({ fetchImpl }).viewer(), null);
});

test("sign-in not being configured is not an error either", async () => {
  const { fetchImpl } = stubFetch({ "/auth/me": () => respond(501, { error: "sign_in_not_configured" }) });
  assert.equal(await new ApiClient({ fetchImpl }).viewer(), null);
});

test("a viewer comes back as the api states it", async () => {
  const { fetchImpl } = stubFetch({
    "/auth/me": () => respond(200, { login: "ali", id: 1, expiresAt: "2026-10-15T22:00:00.000Z" }),
  });
  const viewer = await new ApiClient({ fetchImpl }).viewer();
  assert.equal(viewer?.login, "ali");
});

test("an office is validated before it is handed on", async () => {
  const good = stubFetch({ "/office/repofloor/repofloor": () => respond(200, state) });
  const loaded = await new ApiClient({ fetchImpl: good.fetchImpl }).office("repofloor/repofloor");
  assert.equal(loaded.office.id, "repofloor/repofloor");

  const bad = stubFetch({ "/office/repofloor/repofloor": () => respond(200, { hello: "world" }) });
  await assert.rejects(
    () => new ApiClient({ fetchImpl: bad.fetchImpl }).office("repofloor/repofloor"),
    (err: unknown) => err instanceof ApiError && err.kind === "bad_response",
  );
});

test("a refused office is not_found, which is all the api will say", async () => {
  const { fetchImpl } = stubFetch({
    "/office/secret/repo": () => respond(404, { error: "unknown_office", officeId: "secret/repo" }),
  });
  await assert.rejects(
    () => new ApiClient({ fetchImpl }).office("secret/repo"),
    (err: unknown) => err instanceof ApiError && err.kind === "not_found",
  );
});

test("a listing keeps `partial`, and defaults it to false rather than undefined", async () => {
  const { fetchImpl } = stubFetch({
    "/offices": () => respond(200, { offices: [{ officeId: "a/b", name: "b", buildingId: "a", generatedAt: "x", actors: 0 }] }),
  });
  const listing = await new ApiClient({ fetchImpl }).offices();
  assert.equal(listing.partial, false);
  assert.equal(listing.offices.length, 1);
});

test("a network failure is `offline`, not `unavailable`", async () => {
  const { fetchImpl } = stubFetch({});
  await assert.rejects(
    () => new ApiClient({ fetchImpl }).offices(),
    (err: unknown) => err instanceof ApiError && err.kind === "offline",
  );
});

test("a base prefixes every path, and logout is a POST", async () => {
  const { fetchImpl, calls } = stubFetch({ "https://api.example/auth/logout": () => respond(200, { ok: true }) });
  await new ApiClient({ base: "https://api.example/", fetchImpl }).logout();
  assert.deepEqual(calls, ["POST https://api.example/auth/logout"]);
});
