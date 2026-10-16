/**
 * Periodic resync (2D-3). The thing worth testing is not that it fetches — it is that
 * a sweep keeps going when one repository is broken, and that a resync *replaces*
 * rather than merges, since repairing a snapshot by merging into it would preserve
 * exactly the staleness it exists to remove.
 *
 * No GitHub and no App: `collect` and the token minting are both injected.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyOfficeState, type OfficeState } from "@repofloor/protocol";
import type { GitHubAppAuth } from "../src/app-auth.ts";
import { InMemoryInstallationStore, type Installation } from "../src/installations.ts";
import { createLogger } from "../src/log.ts";
import { InMemoryEventPublisher } from "../src/publisher.ts";
import { resyncAll, resyncOffice, scheduleResync, type ResyncDeps } from "../src/resync.ts";
import { InMemoryOfficeStore } from "../src/store.ts";

const OFFICE = "repofloor/repofloor";
const OTHER = "repofloor/engine";

function state(officeId: string, actorIds: string[] = []): OfficeState {
  const [owner, repo] = officeId.split("/") as [string, string];
  const base = emptyOfficeState(
    { id: owner, name: owner, kind: "organization" },
    { id: officeId, buildingId: owner, name: repo, private: false },
    "full",
  );
  return {
    ...base,
    actors: actorIds.map((id) => ({
      actor: { id, kind: "human" as const },
      status: "coding" as const,
      lastSeen: "2026-10-16T09:00:00.000Z",
    })),
  };
}

const installation = (login: string, id: number): Installation => ({
  installationId: id,
  accountLogin: login,
  accountId: id * 10,
  accountType: "Organization",
  repositorySelection: "all",
});

/** Mints a token without a private key, and records what it was asked for. */
function fakeAppAuth(): GitHubAppAuth & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    async installationToken(id: number) {
      asked.push(id);
      return `ghs_token_for_${id}`;
    },
  } as unknown as GitHubAppAuth & { asked: number[] };
}

interface Harness {
  deps: ResyncDeps;
  store: InMemoryOfficeStore;
  publisher: InMemoryEventPublisher;
  appAuth: ReturnType<typeof fakeAppAuth>;
  collected: Array<{ owner: string; repo: string; token: string; mode?: string }>;
  lines: Array<Record<string, unknown>>;
}

async function harness(options: { collect?: (o: never) => Promise<OfficeState> } = {}): Promise<Harness> {
  const store = new InMemoryOfficeStore();
  const publisher = new InMemoryEventPublisher();
  const installations = new InMemoryInstallationStore();
  const appAuth = fakeAppAuth();
  const collected: Harness["collected"] = [];
  const lines: Array<Record<string, unknown>> = [];

  await installations.upsert(installation("repofloor", 42));

  const deps: ResyncDeps = {
    store,
    publisher,
    installations,
    appAuth,
    logger: createLogger({ write: (l) => void lines.push(JSON.parse(l)) }),
    collectImpl: (options.collect ??
      (async (o: { owner: string; repo: string; token: string; mode?: string }) => {
        collected.push(o);
        return state(`${o.owner}/${o.repo}`, ["fresh-from-github"]);
      })) as unknown as ResyncDeps["collectImpl"],
  };

  return { deps, store, publisher, appAuth, collected, lines };
}

test("a resync replaces the snapshot rather than merging into it", async () => {
  const h = await harness();
  // What we accumulated from webhooks, including someone who has since gone.
  await h.store.save(OFFICE, state(OFFICE, ["stale-one", "stale-two"]));

  const outcome = await resyncOffice(OFFICE, h.deps);

  assert.deepEqual(outcome, { status: "resynced", officeId: OFFICE, actors: 1 });
  const after = await h.store.load(OFFICE);
  assert.deepEqual(
    after?.actors.map((a) => a.actor.id),
    ["fresh-from-github"],
    "merging would have kept the stale actors, which is the staleness this exists to remove",
  );
});

test("it mints an installation token for the office's owner", async () => {
  const h = await harness();
  await h.store.save(OFFICE, state(OFFICE));

  await resyncOffice(OFFICE, h.deps);

  assert.deepEqual(h.appAuth.asked, [42]);
  assert.equal(h.collected[0]?.token, "ghs_token_for_42");
  assert.equal(h.collected[0]?.owner, "repofloor");
  assert.equal(h.collected[0]?.repo, "repofloor");
});

test("the rebuilt snapshot says full, not lite", async () => {
  // The engine reads `mode` to know whether to expect live presence. A resync that
  // claimed to be Lite would quietly downgrade a Full office.
  const h = await harness();
  await h.store.save(OFFICE, state(OFFICE));

  await resyncOffice(OFFICE, h.deps);
  assert.equal(h.collected[0]?.mode, "full");
});

test("it publishes a snapshot with no events", async () => {
  const h = await harness();
  await h.store.save(OFFICE, state(OFFICE));

  await resyncOffice(OFFICE, h.deps);

  assert.equal(h.publisher.published.length, 1);
  assert.deepEqual(h.publisher.published[0]?.events, [], "there is nothing to animate");
  assert.equal(h.publisher.published[0]?.officeId, OFFICE);
});

test("an office whose owner has no installation is skipped, not failed", async () => {
  const h = await harness();
  await h.store.save("someone-else/repo", state("someone-else/repo"));

  const outcome = await resyncOffice("someone-else/repo", h.deps);

  assert.deepEqual(outcome, { status: "no_installation", officeId: "someone-else/repo" });
  assert.deepEqual(h.appAuth.asked, [], "no token is minted for an account we are not installed on");
  assert.equal(h.publisher.published.length, 0);
});

test("a malformed office id fails without reaching GitHub", async () => {
  const h = await harness();
  const outcome = await resyncOffice("not-an-office", h.deps);
  assert.equal(outcome.status, "failed");
  assert.deepEqual(h.appAuth.asked, []);
});

test("one broken repository does not stop the sweep", async () => {
  // The case this is for: an installation removed, or a repository deleted, while we
  // were not looking. Stopping at the first one would mean every office after it
  // silently stops being repaired.
  let calls = 0;
  const h = await harness({
    collect: (async (o: { owner: string; repo: string }) => {
      calls += 1;
      if (o.repo === "repofloor") throw new Error("404 Not Found");
      return state(`${o.owner}/${o.repo}`, ["fresh"]);
    }) as never,
  });
  await h.store.save(OFFICE, state(OFFICE, ["stale"]));
  await h.store.save(OTHER, state(OTHER, ["stale"]));

  const outcomes = await resyncAll(h.deps);

  assert.equal(calls, 2, "it carried on after the failure");
  assert.equal(outcomes.find((o) => o.officeId === OFFICE)?.status, "failed");
  assert.equal(outcomes.find((o) => o.officeId === OTHER)?.status, "resynced");

  // The one that failed keeps what it had — a failed repair must not destroy.
  assert.deepEqual((await h.store.load(OFFICE))?.actors.map((a) => a.actor.id), ["stale"]);
  assert.deepEqual((await h.store.load(OTHER))?.actors.map((a) => a.actor.id), ["fresh"]);
});

test("the sweep reports what it did", async () => {
  const h = await harness();
  await h.store.save(OFFICE, state(OFFICE));
  await h.store.save("someone-else/repo", state("someone-else/repo"));

  await resyncAll(h.deps);

  const summary = h.lines.find((l) => l["msg"] === "resync sweep finished");
  assert.equal(summary?.["offices"], 2);
  assert.equal(summary?.["resynced"], 1);
  assert.equal(summary?.["skipped"], 1);
  assert.equal(summary?.["failed"], 0);
});

test("a sweep that outlasts its interval is skipped, not stacked", async () => {
  const h = await harness();
  await h.store.save(OFFICE, state(OFFICE));

  let release: (() => void) | undefined;
  let started = 0;
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.deps.collectImpl = (async (o: { owner: string; repo: string }) => {
    started += 1;
    await slow;
    return state(`${o.owner}/${o.repo}`);
  }) as unknown as ResyncDeps["collectImpl"];

  const schedule = scheduleResync(h.deps, 10);
  await new Promise((r) => setTimeout(r, 60)); // several intervals pass

  assert.equal(started, 1, "the second and third rounds saw one running and stood down");
  assert.ok(h.lines.some((l) => l["msg"] === "resync still running, skipping this round"));

  release?.();
  schedule.stop();
});

test("nothing runs on startup, only on the interval", async () => {
  // A restart is when the service can least spare the requests.
  const h = await harness();
  await h.store.save(OFFICE, state(OFFICE));

  const schedule = scheduleResync(h.deps, 60_000);
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(h.collected.length, 0);
  schedule.stop();
});
