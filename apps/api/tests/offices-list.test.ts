/**
 * `GET /offices`. The listing obeys the same rule as a single read: public offices
 * for anyone, private ones only for a caller GitHub vouches for. A listing that
 * leaked the *names* of private repositories would be a second ACL by accident.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createApp } from "../src/app.ts";
import { InMemoryOfficeStore } from "../src/store.ts";
import { signWebhook } from "../src/signature.ts";
import { createLogger } from "../src/log.ts";
import type { AccessDecision, RepoAccess } from "../src/access.ts";

const SECRET = "webhook-secret";

const push = (fullName: string, isPrivate: boolean) => ({
  repository: {
    full_name: fullName,
    name: fullName.split("/")[1],
    default_branch: "main",
    private: isPrivate,
    owner: { login: fullName.split("/")[0], type: "Organization" },
  },
  ref: "refs/heads/main",
  commits: [{ id: "a" }],
  sender: { login: "aliosmanmho" },
});

class FakeAccess implements RepoAccess {
  readonly asked: string[] = [];
  allowed = new Map<string, Set<string>>();
  unavailable = new Set<string>();

  async canRead(officeId: string, token: string | undefined): Promise<AccessDecision> {
    this.asked.push(officeId);
    if (this.unavailable.has(officeId)) return { allowed: false, reason: "unavailable" };
    if (!token) return { allowed: false, reason: "unauthenticated" };
    return this.allowed.get(officeId)?.has(token)
      ? { allowed: true, cached: false }
      : { allowed: false, reason: "forbidden", cached: false };
  }

  invalidateOffice(): void {}
}

async function withServer<T>(
  access: FakeAccess,
  fn: (base: string, logs: Array<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  const logs: Array<Record<string, unknown>> = [];
  const app = createApp({
    webhookSecret: SECRET,
    store: new InMemoryOfficeStore(),
    access,
    logger: createLogger({ write: (line) => void logs.push(JSON.parse(line)) }),
  });
  const server: Server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  // Two offices exist: one public, one private.
  let delivery = 0;
  for (const [fullName, isPrivate] of [
    ["repofloor/repofloor", false],
    ["repofloor/secret-lab", true],
  ] as const) {
    const body = JSON.stringify(push(fullName, isPrivate));
    const res = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": `d-${(delivery += 1)}`,
        "x-hub-signature-256": signWebhook(SECRET, Buffer.from(body)),
      },
      body,
    });
    assert.equal(res.status, 202);
  }

  try {
    return await fn(base, logs);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const list = async (base: string, token?: string) => {
  const res = await fetch(`${base}/offices`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: (await res.json()) as { offices: Array<{ officeId: string }>; partial: boolean } };
};

test("an anonymous caller sees only the public office, and GitHub is never asked", async () => {
  const access = new FakeAccess();
  await withServer(access, async (base) => {
    const { status, body } = await list(base);
    assert.equal(status, 200);
    assert.deepEqual(
      body.offices.map((o) => o.officeId),
      ["repofloor/repofloor"],
    );
    assert.equal(body.partial, false);
    assert.deepEqual(access.asked, [], "no credential means nothing to ask GitHub about");
  });
});

test("a caller GitHub vouches for also sees the private office", async () => {
  const access = new FakeAccess();
  access.allowed.set("repofloor/secret-lab", new Set(["gho_alice"]));
  await withServer(access, async (base) => {
    const { body } = await list(base, "gho_alice");
    assert.deepEqual(
      body.offices.map((o) => o.officeId).sort(),
      ["repofloor/repofloor", "repofloor/secret-lab"],
    );
    assert.deepEqual(access.asked, ["repofloor/secret-lab"], "the public office needs no check");
  });
});

test("a caller GitHub refuses cannot even learn the private office exists", async () => {
  const access = new FakeAccess();
  access.allowed.set("repofloor/secret-lab", new Set(["gho_alice"]));
  await withServer(access, async (base) => {
    const { body } = await list(base, "gho_mallory");
    assert.deepEqual(
      body.offices.map((o) => o.officeId),
      ["repofloor/repofloor"],
    );
    assert.equal(body.partial, false, "a refusal is an answer, not a gap");
  });
});

test("GitHub being unreachable omits the office and says the listing is partial", async () => {
  const access = new FakeAccess();
  access.unavailable.add("repofloor/secret-lab");
  await withServer(access, async (base) => {
    const { body } = await list(base, "gho_alice");
    assert.deepEqual(
      body.offices.map((o) => o.officeId),
      ["repofloor/repofloor"],
    );
    assert.equal(body.partial, true);
  });
});

test("a summary carries what a list needs and no snapshot", async () => {
  await withServer(new FakeAccess(), async (base) => {
    const res = await fetch(`${base}/offices`);
    const body = (await res.json()) as { offices: Array<Record<string, unknown>> };
    const [office] = body.offices;
    assert.deepEqual(Object.keys(office ?? {}).sort(), [
      "actors",
      "buildingId",
      "generatedAt",
      "name",
      "officeId",
      "private",
    ]);
  });
});

test("POST /offices is not a route", async () => {
  await withServer(new FakeAccess(), async (base) => {
    const res = await fetch(`${base}/offices`, { method: "POST" });
    assert.equal(res.status, 405);
  });
});

test("each request is logged by path and status, never by query string", async () => {
  await withServer(new FakeAccess(), async (base, logs) => {
    await fetch(`${base}/offices?after=something-secret`);
    const request = logs.filter((l) => l["msg"] === "request").at(-1);
    assert.equal(request?.["path"], "/offices");
    assert.equal(request?.["status"], 200);
    assert.equal(request?.["method"], "GET");
    assert.equal(typeof request?.["durationMs"], "number");
    assert.equal(JSON.stringify(logs).includes("something-secret"), false);
  });
});
