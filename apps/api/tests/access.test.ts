import { test } from "node:test";
import assert from "node:assert/strict";
import { accessInvalidations, bearerToken, GitHubRepoAccess } from "../src/access.ts";

const OFFICE = "repofloor/private-office";

interface FakeGitHub {
  fetchImpl: typeof fetch;
  calls: string[];
  status: number;
  fail: boolean;
}

function fakeGitHub(status = 200): FakeGitHub {
  const gh: FakeGitHub = {
    calls: [],
    status,
    fail: false,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      gh.calls.push(String(input));
      if (gh.fail) throw new Error("network down");
      const auth = (init?.headers as Record<string, string> | undefined)?.["authorization"];
      assert.ok(auth?.startsWith("Bearer "), "the caller's token is what we ask GitHub with");
      return new Response("{}", { status: gh.status });
    }) as unknown as typeof fetch,
  };
  return gh;
}

test("a token GitHub accepts may read, and the answer is cached", async () => {
  const gh = fakeGitHub(200);
  const access = new GitHubRepoAccess({ fetchImpl: gh.fetchImpl, ttlMs: 60_000 });

  assert.deepEqual(await access.canRead(OFFICE, "gho_alice"), { allowed: true, cached: false });
  assert.deepEqual(await access.canRead(OFFICE, "gho_alice"), { allowed: true, cached: true });
  assert.equal(gh.calls.length, 1, "the second read is served from cache");
  assert.equal(gh.calls[0], "https://api.github.com/repos/repofloor/private-office");
});

test("a token GitHub 404s is refused, and that is cached too", async () => {
  const gh = fakeGitHub(404);
  const access = new GitHubRepoAccess({ fetchImpl: gh.fetchImpl });

  assert.deepEqual(await access.canRead(OFFICE, "gho_bob"), { allowed: false, reason: "forbidden", cached: false });
  assert.deepEqual(await access.canRead(OFFICE, "gho_bob"), { allowed: false, reason: "forbidden", cached: true });
  assert.equal(gh.calls.length, 1);
});

test("every caller is asked about separately", async () => {
  const gh = fakeGitHub(200);
  const access = new GitHubRepoAccess({ fetchImpl: gh.fetchImpl });

  await access.canRead(OFFICE, "gho_alice");
  await access.canRead(OFFICE, "gho_bob");
  assert.equal(gh.calls.length, 2, "the cache is keyed by (caller, repo), not by repo");
  assert.equal(access.size, 2);
});

test("no token at all is unauthenticated, and GitHub is never asked", async () => {
  const gh = fakeGitHub(200);
  const access = new GitHubRepoAccess({ fetchImpl: gh.fetchImpl });

  assert.deepEqual(await access.canRead(OFFICE, undefined), { allowed: false, reason: "unauthenticated" });
  assert.equal(gh.calls.length, 0);
});

test("the cached answer expires with the TTL", async () => {
  const gh = fakeGitHub(200);
  let clock = 1_000;
  const access = new GitHubRepoAccess({ fetchImpl: gh.fetchImpl, ttlMs: 60_000, now: () => clock });

  await access.canRead(OFFICE, "gho_alice");
  clock += 59_000;
  assert.equal((await access.canRead(OFFICE, "gho_alice")).allowed, true);
  assert.equal(gh.calls.length, 1);

  clock += 2_000; // past the TTL
  gh.status = 404; // access was revoked in the meantime
  assert.deepEqual(await access.canRead(OFFICE, "gho_alice"), { allowed: false, reason: "forbidden", cached: false });
  assert.equal(gh.calls.length, 2);
});

test("invalidating an office drops its cached answers immediately", async () => {
  const gh = fakeGitHub(200);
  const access = new GitHubRepoAccess({ fetchImpl: gh.fetchImpl });

  await access.canRead(OFFICE, "gho_alice");
  await access.canRead("repofloor/other", "gho_alice");
  access.invalidateOffice(OFFICE);
  assert.equal(access.size, 1, "only the invalidated office is forgotten");

  gh.status = 404;
  assert.equal((await access.canRead(OFFICE, "gho_alice")).allowed, false, "re-asked, not reused");
  assert.equal((await access.canRead("repofloor/other", "gho_alice")).allowed, true, "the other office is untouched");
});

test("a GitHub outage fails closed and is not cached", async () => {
  const gh = fakeGitHub(200);
  const access = new GitHubRepoAccess({ fetchImpl: gh.fetchImpl });

  gh.fail = true;
  assert.deepEqual(await access.canRead(OFFICE, "gho_alice"), { allowed: false, reason: "unavailable" });

  gh.fail = false;
  assert.equal((await access.canRead(OFFICE, "gho_alice")).allowed, true, "no negative answer was pinned");

  const serverError = new GitHubRepoAccess({ fetchImpl: fakeGitHub(500).fetchImpl });
  assert.deepEqual(await serverError.canRead(OFFICE, "gho_alice"), { allowed: false, reason: "unavailable" });
});

test("the cache holds at most maxEntries decisions", async () => {
  const gh = fakeGitHub(200);
  const access = new GitHubRepoAccess({ fetchImpl: gh.fetchImpl, maxEntries: 2 });

  for (const token of ["a", "b", "c", "d"]) await access.canRead(OFFICE, token);
  assert.equal(access.size, 2);
});

test("bearerToken reads both header spellings GitHub documents", () => {
  assert.equal(bearerToken("Bearer gho_abc"), "gho_abc");
  assert.equal(bearerToken("token gho_abc"), "gho_abc");
  assert.equal(bearerToken("BEARER gho_abc"), "gho_abc");
  assert.equal(bearerToken(["Bearer gho_abc"]), "gho_abc");
  assert.equal(bearerToken("Basic dXNlcjpwYXNz"), undefined);
  assert.equal(bearerToken("gho_abc"), undefined);
  assert.equal(bearerToken(undefined), undefined);
});

test("accessInvalidations picks the offices whose readers may have changed", () => {
  assert.deepEqual(
    accessInvalidations("installation_repositories", {
      repositories_added: [{ full_name: "repofloor/a" }],
      repositories_removed: [{ full_name: "repofloor/b" }],
    }),
    ["repofloor/a", "repofloor/b"],
  );

  assert.deepEqual(
    accessInvalidations("member", { action: "removed", repository: { full_name: "repofloor/a" } }),
    ["repofloor/a"],
  );

  assert.deepEqual(accessInvalidations("push", { repository: { full_name: "repofloor/a" } }), [], "a push changes nothing about access");
  assert.deepEqual(accessInvalidations("installation_repositories", {}), []);
  assert.deepEqual(accessInvalidations("member", { repository: { full_name: "not-a-repo" } }), []);
});
