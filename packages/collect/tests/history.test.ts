/**
 * The backfill stepper (ADR 0003, H4).
 *
 * The risks here are not "does it fetch". They are: does the cursor actually advance,
 * does it stop, and does it stop *without* a page having told it to — because a walk
 * that loops forever on the first commit is a job that never finishes and a rate limit
 * spent for nothing, and nothing in the output would say so.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FIRST_STEP, historyStep, type HistoryCursor } from "../src/history.ts";

const OWNER = "repofloor";
const REPO = "repofloor";

interface Fake {
  fetchImpl: typeof fetch;
  asked: string[];
}

/** A GitHub whose pages are a table of `[pathSubstring, pages]`. */
function fakeGitHub(pages: Record<string, unknown[][]>): Fake {
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    const u = new URL(String(url));
    asked.push(`${u.pathname}${u.search}`);

    if (u.pathname.endsWith("/commits")) {
      const until = u.searchParams.get("until");
      const all = (pages["commits"] ?? []).flat() as Array<{ commit: { author: { date: string } } }>;
      // Newest first, and `until` is inclusive — the real endpoint's behaviour.
      const kept = all
        .filter((c) => !until || Date.parse(c.commit.author.date) <= Date.parse(until))
        .sort((a, b) => Date.parse(b.commit.author.date) - Date.parse(a.commit.author.date))
        .slice(0, Number(u.searchParams.get("per_page") ?? 100));
      return new Response(JSON.stringify(kept), { status: 200 });
    }

    const key = u.pathname.endsWith("/pulls") ? "pulls" : u.pathname.endsWith("/issues") ? "issues" : "";
    const page = Number(u.searchParams.get("page") ?? "1");
    return new Response(JSON.stringify(pages[key]?.[page - 1] ?? []), { status: 200 });
  }) as unknown as typeof fetch;

  return { fetchImpl, asked };
}

const commit = (sha: string, date: string) => ({
  sha,
  html_url: `https://example.test/${sha}`,
  author: { login: "ali" },
  commit: { author: { date } },
});

const pull = (number: number, created: string, merged?: string) => ({
  number,
  title: `PR ${number}`,
  html_url: `https://example.test/pull/${number}`,
  user: { login: "ali" },
  state: merged ? "closed" : "open",
  created_at: created,
  updated_at: created,
  ...(merged ? { merged_at: merged, closed_at: merged } : {}),
});

const issue = (number: number, created: string, closed?: string) => ({
  number,
  title: `Issue ${number}`,
  html_url: `https://example.test/issues/${number}`,
  user: { login: "ayse" },
  created_at: created,
  updated_at: created,
  ...(closed ? { closed_at: closed } : {}),
});

const run = (fake: Fake, cursor?: HistoryCursor, budget?: number) =>
  historyStep({ owner: OWNER, repo: REPO, token: "t", fetchImpl: fake.fetchImpl, ...(cursor ? { cursor } : {}), ...(budget ? { budget } : {}) });

test("a small repository is walked in one step and says it is done", async () => {
  const fake = fakeGitHub({
    commits: [[commit("a", "2024-01-01T00:00:00Z"), commit("b", "2024-02-01T00:00:00Z")]],
    pulls: [[pull(1, "2024-01-15T00:00:00Z", "2024-01-16T00:00:00Z")]],
    issues: [[issue(1, "2024-01-20T00:00:00Z")]],
  });

  const step = await run(fake);

  assert.equal(step.done, true);
  assert.deepEqual(step.events.map((e) => e.type).sort(), ["issue.opened", "pr.merged", "pr.opened", "push", "push"]);
  assert.deepEqual(step.actors.map((a) => a.id).sort(), ["ali", "ayse"]);
});

test("events come back in the order they happened", async () => {
  // A replay feeds these straight into the reducer, which takes its time from `at`.
  const fake = fakeGitHub({
    commits: [[commit("a", "2024-03-01T00:00:00Z"), commit("b", "2024-01-01T00:00:00Z")]],
    pulls: [[pull(1, "2024-02-01T00:00:00Z")]],
    issues: [[issue(1, "2024-04-01T00:00:00Z")]],
  });

  const step = await run(fake);
  const times = step.events.map((e) => Date.parse(e.at));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test("a pull request contributes both its opening and its close", async () => {
  // The whole reason for a history: the close is a different moment from the open.
  const fake = fakeGitHub({
    commits: [[]],
    pulls: [[pull(7, "2024-01-01T00:00:00Z", "2024-06-01T00:00:00Z")]],
    issues: [[]],
  });

  const step = await run(fake);
  const pr = step.events.filter((e) => e.type.startsWith("pr."));
  assert.deepEqual(pr.map((e) => [e.type, e.at]), [
    ["pr.opened", "2024-01-01T00:00:00Z"],
    ["pr.merged", "2024-06-01T00:00:00Z"],
  ]);
});

test("the commit cursor walks backwards and stops at the first commit", async () => {
  // 150 commits over 150 days: more than one page, so it takes more than one step.
  const commits = Array.from({ length: 150 }, (_, i) =>
    commit(`sha-${i}`, new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString()),
  );
  const fake = fakeGitHub({ commits: [commits], pulls: [[]], issues: [[]] });

  let cursor: HistoryCursor = FIRST_STEP;
  let total = 0;
  let steps = 0;
  for (;;) {
    const step = await run(fake, cursor, 2);
    total += step.events.filter((e) => e.type === "push").length;
    cursor = step.cursor;
    steps += 1;
    if (step.done) break;
    assert.ok(steps < 20, "it should not take twenty steps to walk 150 commits");
  }

  assert.ok(steps > 1, "more than a page means more than one step");
  // `until` is inclusive, so the boundary commit is seen twice; the store dedups on
  // the event id. What matters is that every commit was reached.
  assert.ok(total >= 150, `saw ${total} push events for 150 commits`);
});

test("a repository with one commit terminates instead of asking forever", async () => {
  // The loop this guards: `until` is inclusive, so a single commit comes back on
  // every request. Without the no-progress check it would never finish.
  const fake = fakeGitHub({ commits: [[commit("only", "2024-01-01T00:00:00Z")]], pulls: [[]], issues: [[]] });

  const step = await run(fake, FIRST_STEP, 50);
  assert.equal(step.done, true);
  assert.ok(step.spent < 6, `spent ${step.spent} requests on a one-commit repository`);
});

test("an empty repository is done immediately and costs almost nothing", async () => {
  const fake = fakeGitHub({ commits: [[]], pulls: [[]], issues: [[]] });
  const step = await run(fake);

  assert.equal(step.done, true);
  assert.deepEqual(step.events, []);
  assert.equal(step.spent, 4, "a probe that the repository exists, then one per resource");
});

test("the budget is what ends a step, and the cursor carries the rest", async () => {
  const pulls = Array.from({ length: 5 }, (_, p) =>
    Array.from({ length: 100 }, (_, i) => pull(p * 100 + i + 1, "2024-01-01T00:00:00Z")),
  );
  const fake = fakeGitHub({ commits: [[]], pulls, issues: [[]] });

  const first = await run(fake, FIRST_STEP, 3);
  assert.equal(first.done, false, "five pages cannot fit in three requests");
  assert.ok(first.cursor.pullsPage > 1, "the cursor moved on");
  assert.ok(first.spent <= 3, `spent ${first.spent} with a budget of 3`);

  // Resuming reaches the end rather than starting over.
  let cursor = first.cursor;
  for (let i = 0; i < 10 && cursor.pullsPage > 0; i++) cursor = (await run(fake, cursor, 3)).cursor;
  assert.equal(cursor.pullsPage, 0);
});

test("a resumed step does not re-walk what the cursor already covered", async () => {
  const pulls = [
    Array.from({ length: 100 }, (_, i) => pull(i + 1, "2024-01-01T00:00:00Z")),
    [pull(101, "2024-02-01T00:00:00Z")],
  ];
  const fake = fakeGitHub({ commits: [[]], pulls, issues: [[]] });

  const first = await run(fake, FIRST_STEP, 2);
  const second = await run(fake, first.cursor, 5);

  const firstNumbers = new Set(first.events.filter((e) => e.type === "pr.opened").map((e) => e.pr.number));
  const secondNumbers = second.events.filter((e) => e.type === "pr.opened").map((e) => e.pr.number);
  assert.ok(secondNumbers.length > 0);
  assert.ok(secondNumbers.every((num) => !firstNumbers.has(num)), "the second step covered new ground");
});

test("a repository with no commits yet (409) is not a failed backfill", async () => {
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("/commits")) return new Response("{}", { status: 409 });
    return new Response("[]", { status: 200 });
  }) as unknown as typeof fetch;

  const step = await historyStep({ owner: OWNER, repo: REPO, token: "t", fetchImpl });
  assert.equal(step.done, true);
  assert.deepEqual(step.events, []);
});

test("a repository that is gone fails instead of walking to completion in three requests", async () => {
  // The same mistake collect made by blanking an office, wearing different clothes:
  // every endpoint 404s for a missing repository, and a 404 means "empty page" to the
  // pager — so without a probe it finishes instantly and is marked fully backfilled.
  const fetchImpl = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(() => historyStep({ owner: OWNER, repo: "gone", token: "t", fetchImpl }), /404/);
});

test("a real failure still fails", async () => {
  const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(() => historyStep({ owner: OWNER, repo: REPO, token: "t", fetchImpl }), /500/);
});
