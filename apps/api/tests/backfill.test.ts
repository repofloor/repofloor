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
  await h.backfills.save({ officeId: OFFICE, cursor: { pullsPage: 4, issuesPage: 2 }, done: false, spent: 9 });

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
