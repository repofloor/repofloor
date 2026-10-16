import { test } from "node:test";
import assert from "node:assert/strict";
import { collect, MAX_PAGES } from "../src/index.ts";

const NOW = new Date("2026-10-15T10:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

const fixtures: Record<string, unknown> = {
  "/repos/repofloor/repofloor": { default_branch: "main", description: "d", private: false, owner: { login: "repofloor", type: "Organization", avatar_url: "a" } },
  "/repos/repofloor/repofloor/contributors?per_page=30": [{ login: "ali", avatar_url: "x" }, { login: "ayse", avatar_url: "y" }, { login: "old-timer", avatar_url: "z" }],
  "/repos/repofloor/repofloor/commits": [
    { sha: "s1", html_url: "u1", author: { login: "ali" }, commit: { author: { date: ago(1) } } },
    { sha: "s2", html_url: "u2", author: { login: "ayse" }, commit: { author: { date: ago(30) } } },
  ],
  "/repos/repofloor/repofloor/pulls": [
    { number: 5, title: "open pr", state: "open", user: { login: "ayse" }, html_url: "p5", draft: false, requested_reviewers: [{ login: "ali" }], updated_at: ago(2), created_at: ago(5), head: { ref: "feat/x" } },
    { number: 4, title: "merged pr", state: "closed", merged_at: ago(0.5), user: { login: "ali" }, html_url: "p4", draft: false, requested_reviewers: [], updated_at: ago(0.5), created_at: ago(10), head: { ref: "feat/y" } },
  ],
  "/repos/repofloor/repofloor/issues": [
    { number: 9, title: "bug", state: "open", user: { login: "ayse" }, assignees: [], html_url: "i9", updated_at: ago(3) },
    { number: 8, title: "pr as issue", state: "open", pull_request: {}, user: { login: "ali" }, assignees: [], html_url: "i8", updated_at: ago(3) },
  ],
  "/repos/repofloor/repofloor/actions/runs": { workflow_runs: [{ id: 1, status: "completed", conclusion: "success", head_branch: "main", html_url: "r1", updated_at: ago(0.2), actor: { login: "ali" } }] },
};

const fakeFetch: typeof fetch = async (url) => {
  const u = new URL(String(url));
  const key = Object.keys(fixtures).find((k) => u.pathname + (k.includes("?") ? u.search : "") === k || u.pathname === k.split("?")[0]);
  const body = key ? fixtures[key] : [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

test("collect builds a lite snapshot", async () => {
  const state = await collect({ owner: "repofloor", repo: "repofloor", token: "t", fetchImpl: fakeFetch, now: NOW });
  assert.equal(state.mode, "lite");
  assert.equal(state.building.kind, "organization");
  assert.equal(state.office.defaultBranch, "main");
  assert.equal(state.actors.length, 3);
  const ali = state.actors.find((a) => a.actor.id === "ali")!;
  assert.equal(ali.actor.avatarUrl, "x");
  // ali merged #4 half an hour ago → celebrate decayed to coding
  assert.equal(ali.status, "coding");
  const old = state.actors.find((a) => a.actor.id === "old-timer")!;
  assert.equal(old.status, "offline");
  assert.deepEqual(state.pullRequests.map((p) => p.number), [5]);
  assert.deepEqual(state.issues.map((i) => i.number), [9]);
  assert.equal(state.defaultBranchCi, "success");
});

test("a repository that is gone fails rather than collecting an empty office", async () => {
  // `get` turns a 404 into an empty list, which is right for a sub-resource and wrong
  // for the repository itself: Full mode's resync replaces what it has with what it
  // collects, so a valid-but-empty snapshot silently blanks a real office. Found by
  // running a sweep against real GitHub with a repository that only existed in a
  // smoke test — it reported "resynced, actors: 0".
  const fetchImpl = (async (url: string) =>
    new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })) as unknown as typeof fetch;

  await assert.rejects(
    () => collect({ owner: "repofloor", repo: "never-existed", token: "t", fetchImpl, now: NOW }),
    /404/,
  );
});

test("a sub-resource that 404s is still tolerated", async () => {
  // An empty repository answers 409 for commits and 404 for some lists. That must not
  // fail the collection — it is a real, empty office.
  const fetchImpl = (async (url: string) => {
    if (String(url).endsWith("/repos/repofloor/repofloor")) {
      return new Response(
        JSON.stringify({ default_branch: "main", private: false, owner: { login: "repofloor", type: "Organization" } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  }) as unknown as typeof fetch;

  const state = await collect({ owner: "repofloor", repo: "repofloor", token: "t", fetchImpl, now: NOW });
  assert.equal(state.office.id, "repofloor/repofloor");
  assert.deepEqual(state.actors, []);
});

// ── pagination ───────────────────────────────────────────────────────────────
// A busy repository used to be truncated in silence: the first page of commits is a
// hundred, and anything past it was simply lost — no error, and a floor that looked
// merely quiet.

/** Answers paged lists, recording which pages were asked for. */
function pagingFetch(pages: Record<string, unknown[][]>, asked: string[] = []): typeof fetch {
  return (async (url: string) => {
    const u = new URL(String(url));
    asked.push(`${u.pathname}${u.search}`);
    if (u.pathname === "/repos/repofloor/repofloor") {
      return new Response(
        JSON.stringify({ default_branch: "main", private: false, owner: { login: "repofloor", type: "Organization" } }),
        { status: 200 },
      );
    }
    // Keys are `pathSuffix` or `pathSuffix|searchSubstring`, so one list can be
    // answered differently for `state=open` and `state=closed`.
    const key = Object.keys(pages).find((k) => {
      const [suffix, needle] = k.split("|");
      return u.pathname.endsWith(suffix!) && (needle === undefined || u.search.includes(needle));
    });
    const page = Number(u.searchParams.get("page") ?? "1");
    const body = key ? (pages[key]![page - 1] ?? []) : [];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

const commit = (i: number) => ({
  sha: `sha-${i}`,
  html_url: `u${i}`,
  author: { login: "ali" },
  commit: { author: { date: ago(1) } },
});

test("commits are followed past the first page", async () => {
  const asked: string[] = [];
  const fetchImpl = pagingFetch(
    {
      "/commits": [
        Array.from({ length: 100 }, (_, i) => commit(i)),
        Array.from({ length: 30 }, (_, i) => commit(100 + i)),
      ],
    },
    asked,
  );

  const state = await collect({ owner: "repofloor", repo: "repofloor", token: "t", fetchImpl, now: NOW });

  // One push event per commit, so the count is visible in the snapshot.
  const pushes = state.actors.find((a) => a.actor.id === "ali");
  assert.ok(pushes, "the committer is on the floor");
  assert.ok(asked.some((p) => p.includes("/commits") && p.includes("page=2")), "it asked for page 2");
  assert.ok(!asked.some((p) => p.includes("/commits") && p.includes("page=3")), "and stopped on the short page");
});

test("a short first page ends it without a second request", async () => {
  const asked: string[] = [];
  const fetchImpl = pagingFetch({ "/commits": [[commit(1)]] }, asked);

  await collect({ owner: "repofloor", repo: "repofloor", token: "t", fetchImpl, now: NOW });
  assert.ok(!asked.some((p) => p.includes("/commits") && p.includes("page=2")));
});

test("pagination stops at MAX_PAGES rather than running forever", async () => {
  const asked: string[] = [];
  // Every page is full, so only the cap can end this.
  const full = Array.from({ length: 100 }, (_, i) => commit(i));
  const fetchImpl = pagingFetch({ "/commits": Array.from({ length: 50 }, () => full) }, asked);

  await collect({ owner: "repofloor", repo: "repofloor", token: "t", fetchImpl, now: NOW });

  const commitPages = asked.filter((p) => p.includes("/commits")).length;
  assert.equal(commitPages, MAX_PAGES);
});

test("open and closed pull requests are asked for separately", async () => {
  // One `state=all` query cannot honour both rules: an open PR belongs on the floor
  // however old it is, a closed one only if it moved recently.
  const asked: string[] = [];
  const fetchImpl = pagingFetch({}, asked);

  await collect({ owner: "repofloor", repo: "repofloor", token: "t", fetchImpl, now: NOW });

  assert.ok(asked.some((p) => p.includes("/pulls") && p.includes("state=open")));
  assert.ok(asked.some((p) => p.includes("/pulls") && p.includes("state=closed")));
  assert.ok(!asked.some((p) => p.includes("/pulls") && p.includes("state=all")));
});

test("an open pull request nobody has touched in months still reaches the floor", async () => {
  const stale = {
    number: 7,
    title: "stale but open",
    state: "open",
    html_url: "u7",
    user: { login: "ali" },
    updated_at: ago(24 * 90),
    head: { ref: "old" },
  };
  const fetchImpl = pagingFetch({ "/pulls|state=open": [[stale]] });

  const state = await collect({ owner: "repofloor", repo: "repofloor", token: "t", fetchImpl, now: NOW });
  assert.deepEqual(state.pullRequests.map((p) => p.number), [7]);
});

test("closed pull requests stop once a whole page predates the window", async () => {
  const asked: string[] = [];
  const recent = Array.from({ length: 50 }, (_, i) => ({
    number: i,
    title: "recent",
    state: "closed",
    html_url: `u${i}`,
    user: { login: "ali" },
    updated_at: ago(1),
  }));
  const old = Array.from({ length: 50 }, (_, i) => ({
    number: 100 + i,
    title: "ancient",
    state: "closed",
    html_url: `u${100 + i}`,
    user: { login: "ali" },
    updated_at: ago(24 * 365),
  }));
  const fetchImpl = pagingFetch({ "/pulls|state=closed": [recent, old, recent] }, asked);

  await collect({ owner: "repofloor", repo: "repofloor", token: "t", fetchImpl, now: NOW });

  const closedPages = asked.filter((p) => p.includes("/pulls") && p.includes("state=closed")).length;
  assert.equal(closedPages, 2, "it read the page of old ones, saw what it meant, and stopped");
});
