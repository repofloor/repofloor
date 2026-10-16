/**
 * `GET /office/:owner/:repo/events` (ADR 0003, H5).
 *
 * The test that matters most is the boring one: history is behind the *same* check as
 * the snapshot. A private repository's past is at least as revealing as its present,
 * and a read path that forgot to ask would be a hole shaped exactly like a feature.
 *
 * The second: there is no actor parameter, and passing one changes nothing. Replay is
 * office-level (rule 6), and the cheapest way to keep it that way is to never offer
 * the filter.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { OfficeEvent } from "@repofloor/protocol";
import { createApp } from "../src/app.ts";
import { InMemoryOfficeStore } from "../src/store.ts";
import type { AccessDecision, RepoAccess } from "../src/access.ts";

const SECRET = "webhook-secret";
const OFFICE = "repofloor/repofloor";
const PRIVATE = "repofloor/secret-lab";

const push = (id: string, at: string, officeId = OFFICE): OfficeEvent => ({
  id,
  at,
  officeId,
  type: "push",
  actorId: "ali",
  branch: "main",
  commits: 1,
});

class FakeAccess implements RepoAccess {
  allowed = new Set<string>(["gho_alice"]);
  async canRead(_officeId: string, token: string | undefined): Promise<AccessDecision> {
    if (!token) return { allowed: false, reason: "unauthenticated" };
    return this.allowed.has(token) ? { allowed: true, cached: false } : { allowed: false, reason: "forbidden", cached: false };
  }
  invalidateOffice(): void {}
}

async function withServer<T>(fn: (base: string, store: InMemoryOfficeStore) => Promise<T>): Promise<T> {
  const store = new InMemoryOfficeStore();
  const app = createApp({ webhookSecret: SECRET, store, access: new FakeAccess() });
  const server: Server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  // A public office with a week of history, and a private one with history too.
  for (const [officeId, isPrivate] of [[OFFICE, false], [PRIVATE, true]] as const) {
    await store.save(officeId, {
      protocolVersion: "1.0.0",
      generatedAt: "2026-10-16T00:00:00.000Z",
      building: { id: "repofloor", name: "repofloor", kind: "organization" },
      office: { id: officeId, buildingId: "repofloor", name: officeId.split("/")[1]!, private: isPrivate },
      rooms: [],
      actors: [],
      pullRequests: [],
      issues: [],
      mode: "full",
    });
    await store.appendEvents(officeId, [
      push(`${officeId}:1`, "2026-10-10T00:00:00.000Z", officeId),
      push(`${officeId}:2`, "2026-10-12T00:00:00.000Z", officeId),
      push(`${officeId}:3`, "2026-10-14T00:00:00.000Z", officeId),
    ]);
  }

  try {
    return await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const getEvents = async (base: string, officeId: string, query = "", token?: string) => {
  const [owner, repo] = officeId.split("/");
  const r = await fetch(`${base}/office/${owner}/${repo}/events${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

test("a public office's history is readable, in the order it happened", async () => {
  await withServer(async (base) => {
    const { status, body } = await getEvents(base, OFFICE);
    assert.equal(status, 200);
    assert.equal(body["officeId"], OFFICE);
    assert.deepEqual((body["events"] as OfficeEvent[]).map((e) => e.at), [
      "2026-10-10T00:00:00.000Z",
      "2026-10-12T00:00:00.000Z",
      "2026-10-14T00:00:00.000Z",
    ]);
    assert.equal(body["truncated"], false);
  });
});

test("a private office's history needs the same credential its snapshot does", async () => {
  await withServer(async (base) => {
    const anonymous = await getEvents(base, PRIVATE);
    assert.equal(anonymous.status, 401, "history must not be a way around the snapshot check");

    const refused = await getEvents(base, PRIVATE, "", "gho_mallory");
    assert.equal(refused.status, 404, "and a refused caller learns nothing it did not already know");

    const allowed = await getEvents(base, PRIVATE, "", "gho_alice");
    assert.equal(allowed.status, 200);
    assert.equal((allowed.body["events"] as OfficeEvent[]).length, 3);
  });
});

test("the refusal is the same shape the snapshot gives", async () => {
  // Two routes answering the same refusal differently is how a reader learns that a
  // private repository exists.
  await withServer(async (base) => {
    const snapshot = await fetch(`${base}/office/repofloor/secret-lab`);
    const history = await fetch(`${base}/office/repofloor/secret-lab/events`);
    assert.equal(snapshot.status, history.status);
    assert.deepEqual(await snapshot.json(), await history.json());
  });
});

test("from and to narrow the span", async () => {
  await withServer(async (base) => {
    const { body } = await getEvents(base, OFFICE, "?from=2026-10-11T00:00:00.000Z&to=2026-10-13T00:00:00.000Z");
    assert.deepEqual((body["events"] as OfficeEvent[]).map((e) => e.at), ["2026-10-12T00:00:00.000Z"]);
  });
});

test("a limit says when there is more rather than leaving it to be guessed", async () => {
  await withServer(async (base) => {
    const { body } = await getEvents(base, OFFICE, "?limit=2");
    assert.equal((body["events"] as OfficeEvent[]).length, 2);
    assert.equal(body["truncated"], true, "a full page is otherwise indistinguishable from the last one");

    const whole = await getEvents(base, OFFICE, "?limit=3");
    assert.equal(whole.body["truncated"], false);
  });
});

test("a span that is not a span is refused rather than guessed at", async () => {
  await withServer(async (base) => {
    const { status, body } = await getEvents(base, OFFICE, "?from=yesterday");
    assert.equal(status, 400);
    assert.equal(body["error"], "bad_span");
  });
});

test("an actor parameter is not a filter, because there is no filter", async () => {
  // Rule 6, ADR 0003 decision 1. Someone will try; the answer is the whole office.
  await withServer(async (base) => {
    const filtered = await getEvents(base, OFFICE, "?actor=ali");
    const plain = await getEvents(base, OFFICE);
    assert.deepEqual(filtered.body["events"], plain.body["events"]);
  });
});

test("one office's history is not another's, and POST is not a route", async () => {
  await withServer(async (base) => {
    const { body } = await getEvents(base, OFFICE);
    assert.ok((body["events"] as OfficeEvent[]).every((e) => e.officeId === OFFICE));

    const posted = await fetch(`${base}/office/repofloor/repofloor/events`, { method: "POST" });
    assert.equal(posted.status, 405);
  });
});

test("an office nobody has heard of is unknown, not empty", async () => {
  await withServer(async (base) => {
    const { status } = await getEvents(base, "nobody/nothing", "", "gho_alice");
    assert.equal(status, 404);
  });
});
