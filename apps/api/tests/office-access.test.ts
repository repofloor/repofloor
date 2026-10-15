/**
 * `GET /office/:owner/:repo` over a real server: public offices stay open, private ones
 * need a GitHub token that can see the repository, and a webhook that changes access
 * clears what was cached.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createApp } from "../src/app.ts";
import { InMemoryOfficeStore } from "../src/store.ts";
import { signWebhook } from "../src/signature.ts";
import type { AccessDecision, RepoAccess } from "../src/access.ts";

const SECRET = "webhook-secret";

const repository = (isPrivate: boolean) => ({
  full_name: "repofloor/repofloor",
  name: "repofloor",
  default_branch: "main",
  private: isPrivate,
  owner: { login: "repofloor", type: "Organization" },
});

const push = (isPrivate: boolean) => ({
  repository: repository(isPrivate),
  ref: "refs/heads/main",
  commits: [{ id: "a" }],
  sender: { login: "aliosmanmho" },
});

/** Records what it was asked and answers from a table of tokens. */
class FakeAccess implements RepoAccess {
  readonly asked: Array<{ officeId: string; token: string | undefined }> = [];
  readonly invalidated: string[] = [];
  allowedTokens = new Set<string>(["gho_alice"]);
  unavailable = false;

  async canRead(officeId: string, token: string | undefined): Promise<AccessDecision> {
    this.asked.push({ officeId, token });
    if (this.unavailable) return { allowed: false, reason: "unavailable" };
    if (!token) return { allowed: false, reason: "unauthenticated" };
    return this.allowedTokens.has(token)
      ? { allowed: true, cached: false }
      : { allowed: false, reason: "forbidden", cached: false };
  }

  invalidateOffice(officeId: string): void {
    this.invalidated.push(officeId);
  }
}

async function withServer<T>(
  fn: (base: string, access: FakeAccess) => Promise<T>,
  access: FakeAccess = new FakeAccess(),
): Promise<T> {
  const app = createApp({ webhookSecret: SECRET, store: new InMemoryOfficeStore(), access });
  const server: Server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  try {
    return await fn(`http://127.0.0.1:${address.port}`, access);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function deliver(base: string, event: string, deliveryId: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  return fetch(`${base}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signWebhook(SECRET, body),
    },
    body,
  });
}

const read = (base: string, token?: string): Promise<Response> =>
  fetch(`${base}/office/repofloor/repofloor`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);

test("a public office is readable without a token, and GitHub is never asked", async () => {
  await withServer(async (base, access) => {
    assert.equal((await deliver(base, "push", "d1", push(false))).status, 202);

    const res = await read(base);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { office: { id: string } }).office.id, "repofloor/repofloor");
    assert.equal(access.asked.length, 0, "public visibility comes from the signed delivery itself");
  });
});

test("a private office refuses an anonymous read", async () => {
  await withServer(async (base) => {
    assert.equal((await deliver(base, "push", "d1", push(true))).status, 202);

    const res = await read(base);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer /);
    assert.deepEqual(await res.json(), { error: "authentication_required", officeId: "repofloor/repofloor" });
  });
});

test("a private office opens for a token GitHub accepts", async () => {
  await withServer(async (base, access) => {
    await deliver(base, "push", "d1", push(true));

    const res = await read(base, "gho_alice");
    assert.equal(res.status, 200);
    assert.deepEqual(access.asked, [{ officeId: "repofloor/repofloor", token: "gho_alice" }]);
    const state = (await res.json()) as { actors: unknown[] };
    assert.equal(state.actors.length, 1);
  });
});

test("a token without access gets the same 404 as an office that does not exist", async () => {
  await withServer(async (base) => {
    await deliver(base, "push", "d1", push(true));

    const denied = await read(base, "gho_bob");
    assert.equal(denied.status, 404, "whether a private repository exists is itself private");
    assert.deepEqual(await denied.json(), { error: "unknown_office", officeId: "repofloor/repofloor" });

    const missing = await fetch(`${base}/office/nobody/nothing`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "unknown_office", officeId: "nobody/nothing" });
  });
});

test("an office whose visibility we were never told is treated as private", async () => {
  await withServer(async (base) => {
    const payload = push(true) as { repository: Record<string, unknown> };
    delete payload.repository["private"];
    await deliver(base, "push", "d1", payload);

    assert.equal((await read(base)).status, 401, "fail closed, not open");
    assert.equal((await read(base, "gho_alice")).status, 200);
  });
});

test("a GitHub outage answers 503 rather than opening or closing the office for good", async () => {
  const access = new FakeAccess();
  await withServer(async (base) => {
    await deliver(base, "push", "d1", push(true));
    access.unavailable = true;

    const res = await read(base, "gho_alice");
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "access_check_unavailable", officeId: "repofloor/repofloor" });

    access.unavailable = false;
    assert.equal((await read(base, "gho_alice")).status, 200);
  }, access);
});

test("installation_repositories and member deliveries invalidate the cached decisions", async () => {
  await withServer(async (base, access) => {
    assert.equal(
      (
        await deliver(base, "installation_repositories", "d1", {
          action: "removed",
          repositories_removed: [{ full_name: "repofloor/repofloor" }],
        })
      ).status,
      202,
    );
    assert.deepEqual(access.invalidated, ["repofloor/repofloor"]);

    await deliver(base, "member", "d2", {
      action: "removed",
      repository: repository(true),
      member: { login: "bob" },
    });
    assert.deepEqual(access.invalidated, ["repofloor/repofloor", "repofloor/repofloor"]);

    await deliver(base, "push", "d3", push(true));
    assert.equal(access.invalidated.length, 2, "an ordinary delivery invalidates nothing");
  });
});
