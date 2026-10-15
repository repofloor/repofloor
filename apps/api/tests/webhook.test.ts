import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createApp } from "../src/app.ts";
import { InMemoryEventPublisher } from "../src/publisher.ts";
import { InMemoryOfficeStore } from "../src/store.ts";
import { signWebhook } from "../src/signature.ts";

const SECRET = "webhook-secret";
const NOW = "2026-10-15T10:00:00.000Z";

const repository = {
  full_name: "repofloor/repofloor",
  name: "repofloor",
  description: "a living pixel office",
  default_branch: "main",
  private: false,
  owner: { login: "repofloor", type: "Organization", avatar_url: "https://avatars/repofloor" },
};

const pushPayload = {
  repository,
  ref: "refs/heads/feat/api",
  compare: "https://github.com/repofloor/repofloor/compare/a...b",
  commits: [{ id: "a" }, { id: "b" }],
  sender: { login: "aliosmanmho" },
};

const prPayload = {
  repository,
  action: "opened",
  sender: { login: "aliosmanmho" },
  pull_request: {
    number: 17,
    title: "feat(api): webhook receiver",
    user: { login: "aliosmanmho" },
    html_url: "https://github.com/repofloor/repofloor/pull/17",
    draft: false,
    requested_reviewers: [{ login: "ayse" }],
    updated_at: NOW,
  },
};

interface ServerOptions {
  publisher?: InMemoryEventPublisher;
  /**
   * The clock `GET /office/...` decays against. Real time by default: `githubToEvents`
   * stamps events with the wall clock, so a frozen past clock would decay them away.
   */
  now?: () => string;
}

async function withServer<T>(
  fn: (base: string, app: ReturnType<typeof createApp>) => Promise<T>,
  options: ServerOptions = {},
): Promise<T> {
  const publisher = options.publisher ?? new InMemoryEventPublisher();
  const app = createApp({
    webhookSecret: SECRET,
    store: new InMemoryOfficeStore(),
    publisher,
    now: options.now ?? (() => new Date().toISOString()),
  });
  const server: Server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  try {
    return await fn(`http://127.0.0.1:${address.port}`, app);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function deliver(base: string, event: string, deliveryId: string, payload: unknown, opts: { signed?: boolean } = {}) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": deliveryId,
  };
  if (opts.signed !== false) headers["x-hub-signature-256"] = signWebhook(SECRET, body);
  return fetch(`${base}/webhook`, { method: "POST", headers, body });
}

test("a signed push delivery becomes events and shows up on GET /office/:owner/:repo", async () => {
  const publisher = new InMemoryEventPublisher();
  await withServer(async (base) => {
    const res = await deliver(base, "push", "delivery-1", pushPayload);
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { officeId: "repofloor/repofloor", events: 1, applied: 1 });

    const office = await fetch(`${base}/office/repofloor/repofloor`);
    assert.equal(office.status, 200);
    const state = (await office.json()) as Record<string, any>;
    assert.equal(state["mode"], "full");
    assert.equal(state["office"]["id"], "repofloor/repofloor");
    assert.equal(state["office"]["defaultBranch"], "main");
    assert.equal(state["building"]["kind"], "organization");
    assert.ok(Number.isFinite(Date.parse(state["generatedAt"])), "generatedAt is an ISO timestamp");
    const actor = state["actors"].find((a: any) => a.actor.id === "aliosmanmho");
    assert.ok(actor, "the pusher is on the floor");
    assert.equal(actor.status, "coding");
    assert.equal(actor.detail, "feat/api");

    // the publisher saw exactly what was applied — this is what apps/realtime will fan out
    assert.equal(publisher.published.length, 1);
    assert.equal(publisher.published[0]!.officeId, "repofloor/repofloor");
    assert.equal(publisher.published[0]!.events[0]!.type, "push");
  }, { publisher });
});

test("the snapshot decays on read: a long-silent office answers with offline actors", async () => {
  const farFuture = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
  await withServer(async (base) => {
    assert.equal((await deliver(base, "push", "delivery-decay", pushPayload)).status, 202);
    const state = (await (await fetch(`${base}/office/repofloor/repofloor`)).json()) as Record<string, any>;
    assert.equal(state["actors"][0]["status"], "offline");
    assert.equal(state["generatedAt"], farFuture);
  }, { now: () => farFuture });
});

test("a pull_request delivery lands on the wall board", async () => {
  await withServer(async (base) => {
    const res = await deliver(base, "pull_request", "delivery-2", prPayload);
    assert.equal(res.status, 202);

    const state = (await (await fetch(`${base}/office/repofloor/repofloor`)).json()) as Record<string, any>;
    assert.equal(state["pullRequests"].length, 1);
    assert.equal(state["pullRequests"][0]["number"], 17);
    assert.equal(state["pullRequests"][0]["reviewerIds"][0], "ayse");
  });
});

test("an unsigned or wrongly signed delivery is rejected and changes nothing", async () => {
  await withServer(async (base) => {
    const unsigned = await deliver(base, "push", "delivery-3", pushPayload, { signed: false });
    assert.equal(unsigned.status, 401);
    assert.deepEqual(await unsigned.json(), { error: "invalid_signature" });

    const body = JSON.stringify(pushPayload);
    const wrong = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "delivery-4",
        "x-hub-signature-256": signWebhook("not-the-secret", body),
      },
      body,
    });
    assert.equal(wrong.status, 401);

    assert.equal((await fetch(`${base}/office/repofloor/repofloor`)).status, 404);
  });
});

test("re-delivering the same webhook applies nothing the second time", async () => {
  await withServer(async (base) => {
    const first = await deliver(base, "push", "same-delivery", pushPayload);
    assert.equal(((await first.json()) as any).applied, 1);
    const second = await deliver(base, "push", "same-delivery", pushPayload);
    assert.equal(second.status, 202);
    assert.deepEqual(await second.json(), { officeId: "repofloor/repofloor", events: 1, applied: 0 });
  });
});

test("a delivery without a repository, and an event we do not map, are accepted as no-ops", async () => {
  await withServer(async (base) => {
    const ping = await deliver(base, "ping", "delivery-5", { zen: "Keep it logically awesome." });
    assert.equal(ping.status, 202);
    assert.deepEqual(await ping.json(), { events: 0, applied: 0 });

    const unmapped = await deliver(base, "star", "delivery-6", { repository, action: "created" });
    assert.equal(unmapped.status, 202);
    assert.deepEqual(await unmapped.json(), { officeId: "repofloor/repofloor", events: 0, applied: 0 });
  });
});

test("bad headers, bad JSON, unknown offices and wrong methods answer sensibly", async () => {
  await withServer(async (base) => {
    const body = JSON.stringify(pushPayload);
    const noHeaders = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signWebhook(SECRET, body) },
      body,
    });
    assert.equal(noHeaders.status, 400);
    assert.deepEqual(await noHeaders.json(), { error: "missing_github_headers" });

    const broken = "{not json";
    const badJson = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "delivery-7",
        "x-hub-signature-256": signWebhook(SECRET, broken),
      },
      body: broken,
    });
    assert.equal(badJson.status, 400);
    assert.deepEqual(await badJson.json(), { error: "invalid_json" });

    assert.equal((await fetch(`${base}/office/nobody/nothing`)).status, 404);
    assert.equal((await fetch(`${base}/webhook`)).status, 405);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });
});

test("createApp refuses to run without a webhook secret", () => {
  assert.throws(() => createApp({ webhookSecret: "" }), /webhookSecret is required/);
});
