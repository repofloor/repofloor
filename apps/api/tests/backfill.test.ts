/**
 * The backfill (ADR 0003, H4).
 *
 * What the stepper itself does is covered in `@repofloor/collect`. What is tested here
 * is the part that can lose work: that a step stores what it found *before* it records
 * where it stopped, that a resumed step carries on rather than starting over, and that
 * one broken office does not stall the queue behind it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Actor, OfficeEvent } from "@repofloor/protocol";
import {
  backfillStep,
  InMemoryBackfillStore,
  scheduleBackfill,
  retryDelayMs,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  MAX_BACKFILL_FAILURES,
  type BackfillDeps,
} from "../src/backfill.ts";
import type { GitHubAppAuth } from "../src/app-auth.ts";
import { InMemoryInstallationStore } from "../src/installations.ts";
import { createLogger } from "../src/log.ts";
import { InMemoryOfficeStore } from "../src/store.ts";

const OFFICE = "repofloor/repofloor";
const FAR_PAST = "2000-01-01T00:00:00.000Z";
const FAR_FUTURE = "2100-01-01T00:00:00.000Z";

const push = (id: string, at: string): OfficeEvent => ({
  id,
  at,
  officeId: OFFICE,
  type: "push",
  actorId: "ali",
  branch: "main",
  commits: 1,
});

const appAuth = { async installationToken(id: number) { return `ghs_${id}`; } } as unknown as GitHubAppAuth;

async function harness(step: BackfillDeps["stepImpl"]) {
  const store = new InMemoryOfficeStore();
  const backfills = new InMemoryBackfillStore();
  const installations = new InMemoryInstallationStore();
  const lines: Array<Record<string, unknown>> = [];

  await installations.upsert({
    installationId: 7,
    accountLogin: "repofloor",
    accountId: 70,
    accountType: "Organization",
    repositorySelection: "all",
  });

  const deps: BackfillDeps = {
    store,
    backfills,
    installations,
    appAuth,
    logger: createLogger({ write: (l) => void lines.push(JSON.parse(l)) }),
    stepImpl: step,
  };
  return { deps, store, backfills, lines };
}

test("a step stores what it found and remembers where it stopped", async () => {
  const h = await harness(async () => ({
    events: [push("a", "2024-01-01T00:00:00Z"), push("b", "2024-02-01T00:00:00Z")],
    actors: [{ id: "ali", kind: "human", name: "Ali" } as Actor],
    cursor: { pullsPage: 2, issuesPage: 1 },
    done: false,
    spent: 4,
  }));

  const outcome = await backfillStep(OFFICE, h.deps);

  assert.equal(outcome.status, "progressed");
  const stored = await h.store.eventsBetween(OFFICE, FAR_PAST, FAR_FUTURE);
  assert.equal(stored.length, 3, "two pushes and the actor that made them");
  assert.deepEqual(await h.backfills.get(OFFICE), {
    officeId: OFFICE,
    cursor: { pullsPage: 2, issuesPage: 1 },
    done: false,
    spent: 4,
    failures: 0,
  });
});

test("the actor arrives before the events that mention them", async () => {
  // Otherwise a replay to any early point finds a floor of logins with no names.
  const h = await harness(async () => ({
    events: [push("a", "2024-03-01T00:00:00Z")],
    actors: [{ id: "ali", kind: "human", name: "Ali Osman" } as Actor],
    cursor: { pullsPage: 0, issuesPage: 0 },
    done: true,
    spent: 1,
  }));

  await backfillStep(OFFICE, h.deps);
  const stored = await h.store.eventsBetween(OFFICE, FAR_PAST, FAR_FUTURE);

  assert.equal(stored[0]?.type, "actor.upsert");
  assert.ok(Date.parse(stored[0]!.at) <= Date.parse(stored[1]!.at));
});

test("a resumed step is handed the cursor the last one left", async () => {
  const seen: Array<unknown> = [];
  let call = 0;
  const h = await harness(async (opts) => {
    seen.push(opts.cursor);
    call += 1;
    return {
      events: [push(`e${call}`, `2024-0${call}-01T00:00:00Z`)],
      actors: [],
      cursor: { pullsPage: call + 1, issuesPage: 0 },
      done: call >= 2,
      spent: 1,
    };
  });

  await backfillStep(OFFICE, h.deps);
  await backfillStep(OFFICE, h.deps);

  assert.deepEqual(seen[1], { pullsPage: 2, issuesPage: 0 }, "the second step resumed where the first stopped");
  assert.equal((await h.backfills.get(OFFICE))?.done, true);
});

test("spend accumulates across steps, so an expensive repository is visible", async () => {
  let call = 0;
  const h = await harness(async () => {
    call += 1;
    return { events: [], actors: [], cursor: { pullsPage: call, issuesPage: 0 }, done: call >= 3, spent: 10 };
  });

  for (let i = 0; i < 3; i++) await backfillStep(OFFICE, h.deps);
  assert.equal((await h.backfills.get(OFFICE))?.spent, 30);
});

test("a finished office is not walked again", async () => {
  let calls = 0;
  const h = await harness(async () => {
    calls += 1;
    return { events: [], actors: [], cursor: { pullsPage: 0, issuesPage: 0 }, done: true, spent: 1 };
  });

  await backfillStep(OFFICE, h.deps);
  await backfillStep(OFFICE, h.deps);
  assert.equal(calls, 1);
});

test("a failed step does not advance the cursor past work it never stored", async () => {
  // Moving on would leave a hole in the history that nothing would ever report.
  const h = await harness(async () => {
    throw new Error("rate limited");
  });
  await h.backfills.save({
    officeId: OFFICE,
    cursor: { pullsPage: 4, issuesPage: 2 },
    done: false,
    spent: 9,
    failures: 0,
  });

  const outcome = await backfillStep(OFFICE, h.deps);

  assert.equal(outcome.status, "failed");
  assert.deepEqual((await h.backfills.get(OFFICE))?.cursor, { pullsPage: 4, issuesPage: 2 });
  assert.equal((await h.backfills.get(OFFICE))?.done, false);
  assert.deepEqual(await h.store.eventsBetween(OFFICE, FAR_PAST, FAR_FUTURE), []);
});

test("a failing office yields its turn instead of starving the queue", async () => {
  // Watched this happen for real: next() orders by when a row was last touched, so an
  // office with no row is always first. One permanently broken repository took every
  // turn forever and the healthy ones were never walked.
  const h = await harness(async () => {
    throw new Error("404");
  });

  await backfillStep(OFFICE, h.deps);
  const record = await h.backfills.get(OFFICE);

  assert.ok(record, "the failure wrote a record, so the office goes to the back of the queue");
  assert.equal(record.done, false, "and it is still something to do");
});

test("an office whose owner we are not installed on is skipped, not failed", async () => {
  const h = await harness(async () => {
    throw new Error("should not be reached");
  });
  const outcome = await backfillStep("someone-else/repo", h.deps);
  assert.deepEqual(outcome, { status: "no_installation", officeId: "someone-else/repo" });
});

test("the scheduler picks up an office and stops once it is done", async () => {
  let calls = 0;
  const h = await harness(async () => {
    calls += 1;
    return { events: [], actors: [], cursor: { pullsPage: 0, issuesPage: 0 }, done: true, spent: 1 };
  });
  await h.backfills.enqueue(OFFICE);

  const schedule = scheduleBackfill(h.deps, 10);
  await new Promise((r) => setTimeout(r, 80));
  schedule.stop();

  assert.equal(calls, 1, "it walked the office once and then had nothing to do");
});

/*
 * Backing off (005).
 *
 * Yielding the turn stopped one broken office starving the queue. It did not stop the
 * waste: the same deleted repository came back every interval, for ever. What is
 * tested here is that it waits, that waiting is forgotten the moment a step gets
 * through, that waiting never costs a healthy office its turn, and that an office
 * which is never coming back is parked rather than retried — visibly, and without
 * being recorded as finished.
 */

/** A clock the test moves by hand, and a jitter that is not random. */
function clock(start = Date.parse("2026-10-16T12:00:00.000Z")) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => (at += ms),
    get at() {
      return at;
    },
  };
}

const NO_JITTER = () => 0.5;

test("the wait after a failure grows, and is capped", () => {
  const plain = (failures: number) => retryDelayMs(failures, NO_JITTER);

  assert.equal(plain(1), BACKOFF_BASE_MS);
  assert.equal(plain(2), BACKOFF_BASE_MS * 2);
  assert.equal(plain(3), BACKOFF_BASE_MS * 4);
  assert.equal(plain(40), BACKOFF_CAP_MS, "doubling for ever would schedule a retry after the heat death");
});

test("the wait is jittered, so offices that broke together do not come back in lockstep", () => {
  // They fail together far more often than alone: a rate limit, an outage, an
  // installation someone removed.
  const low = retryDelayMs(5, () => 0);
  const high = retryDelayMs(5, () => 1);
  assert.ok(low < high);
  assert.ok(low >= BACKOFF_BASE_MS * 2 ** 4 * 0.7);
});

test("a failing office is told when to come back, and waits there", async () => {
  const c = clock();
  const h = await harness(async () => {
    throw new Error("rate limited");
  });
  h.deps.now = c.now;
  h.deps.random = NO_JITTER;
  await h.backfills.enqueue(OFFICE);

  const outcome = await backfillStep(OFFICE, h.deps);

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.status === "failed" && outcome.failures, 1);
  assert.equal((await h.backfills.get(OFFICE))?.retryAfter, new Date(c.at + BACKOFF_BASE_MS).toISOString());
});

test("an office inside its backoff is not handed out", async () => {
  const c = clock();
  const backfills = new InMemoryBackfillStore(c.now);
  await backfills.save({
    officeId: OFFICE,
    cursor: { pullsPage: 1, issuesPage: 1 },
    done: false,
    spent: 1,
    failures: 2,
    retryAfter: new Date(c.at + 60_000).toISOString(),
  });

  assert.equal(await backfills.next(), undefined, "still waiting");
  c.advance(60_001);
  assert.equal((await backfills.next())?.officeId, OFFICE, "and ready once the wait is over");
});

test("a healthy office keeps its turn while a broken one is backing off", async () => {
  // The whole point. The first fix for starvation was to let a failing office yield;
  // this must not reintroduce the opposite, where backing one off blocks the rest.
  const c = clock();
  const backfills = new InMemoryBackfillStore(c.now);
  await backfills.save({
    officeId: "broken/repo",
    cursor: { pullsPage: 1, issuesPage: 1 },
    done: false,
    spent: 1,
    failures: 3,
    retryAfter: new Date(c.at + 600_000).toISOString(),
  });
  await backfills.enqueue(OFFICE);

  assert.equal((await backfills.next())?.officeId, OFFICE);
});

test("a step that gets through forgets the failures before it", async () => {
  // Consecutive, not cumulative: an office that was rate limited this morning should
  // not be one failure from being parked this afternoon.
  const c = clock();
  const h = await harness(async () => ({
    events: [],
    actors: [],
    cursor: { pullsPage: 3, issuesPage: 0 },
    done: false,
    spent: 2,
  }));
  h.deps.now = c.now;
  await h.backfills.save({
    officeId: OFFICE,
    cursor: { pullsPage: 2, issuesPage: 0 },
    done: false,
    spent: 5,
    failures: 4,
    retryAfter: new Date(c.at - 1000).toISOString(),
  });

  await backfillStep(OFFICE, h.deps);
  const record = await h.backfills.get(OFFICE);

  assert.equal(record?.failures, 0);
  assert.equal(record?.retryAfter, undefined, "and it is not still waiting for a moment that has passed");
});

test("an office that never recovers is parked, not retried for ever", async () => {
  const c = clock();
  const h = await harness(async () => {
    throw new Error("Not Found");
  });
  h.deps.now = c.now;
  h.deps.random = NO_JITTER;
  await h.backfills.enqueue(OFFICE);

  let last;
  for (let i = 0; i < MAX_BACKFILL_FAILURES; i++) {
    last = await backfillStep(OFFICE, h.deps);
    c.advance(BACKOFF_CAP_MS);
  }

  assert.equal(last?.status, "parked");
  const record = await h.backfills.get(OFFICE);
  assert.equal(record?.parked, "Not Found");
  assert.equal(record?.failures, MAX_BACKFILL_FAILURES);
});

test("a parked office is not finished, and is never handed out again", async () => {
  // Marking it done would be the deleted-repository bug in a new costume: an office
  // whose history stops early, recorded as fully walked.
  const c = clock();
  const h = await harness(async () => {
    throw new Error("Not Found");
  });
  h.deps.now = c.now;
  h.deps.random = NO_JITTER;
  await h.backfills.enqueue(OFFICE);

  for (let i = 0; i < MAX_BACKFILL_FAILURES; i++) {
    await backfillStep(OFFICE, h.deps);
    c.advance(BACKOFF_CAP_MS);
  }

  assert.equal((await h.backfills.get(OFFICE))?.done, false, "its history really is unfinished");
  assert.equal(await h.backfills.next(), undefined, "but there is nothing to be gained by trying again");
});

test("parking says which office and why", async () => {
  // A decision to stop trying that nobody can see is indistinguishable from a backfill
  // that silently never ran.
  const c = clock();
  const h = await harness(async () => {
    throw new Error("Repository access blocked");
  });
  h.deps.now = c.now;
  h.deps.random = NO_JITTER;

  for (let i = 0; i < MAX_BACKFILL_FAILURES; i++) {
    await backfillStep(OFFICE, h.deps);
    c.advance(BACKOFF_CAP_MS);
  }

  const parked = h.lines.find((l) => l.msg === "backfill parked");
  assert.ok(parked, "parking is logged");
  assert.equal(parked.officeId, OFFICE);
  assert.equal(parked.reason, "Repository access blocked");
  assert.equal(parked.level, "warn");
});

test("a parked office is not stepped again even when named directly", async () => {
  let calls = 0;
  const h = await harness(async () => {
    calls += 1;
    throw new Error("gone");
  });
  await h.backfills.save({
    officeId: OFFICE,
    cursor: { pullsPage: 1, issuesPage: 1 },
    done: false,
    spent: 3,
    failures: MAX_BACKFILL_FAILURES,
    parked: "gone",
  });

  const outcome = await backfillStep(OFFICE, h.deps);

  assert.deepEqual(outcome, { status: "parked", officeId: OFFICE, reason: "gone" });
  assert.equal(calls, 0, "it did not spend a request to confirm what it already knows");
});

test("an office id that is not one is parked, since waiting cannot fix it", async () => {
  const h = await harness(async () => {
    throw new Error("should not be reached");
  });
  const outcome = await backfillStep("not-an-office-id", h.deps);
  assert.equal(outcome.status, "parked");
});
