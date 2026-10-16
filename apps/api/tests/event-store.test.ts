/**
 * The event log behind an office (ADR 0003, H3).
 *
 * The property that matters is not "events are stored" — it is that the stored events
 * reproduce the snapshot they were stored with. A history that disagrees with the live
 * view would make every replay subtly wrong, and nothing would say so.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyOfficeState, type OfficeEvent } from "@repofloor/protocol";
import { replay } from "@repofloor/reducer";
import type { GithubWebhook } from "@repofloor/reducer";
import { ingestWebhook } from "../src/ingest.ts";
import { InMemoryEventPublisher } from "../src/publisher.ts";
import { InMemoryOfficeStore } from "../src/store.ts";

const OFFICE = "repofloor/repofloor";
const FAR_PAST = "2000-01-01T00:00:00.000Z";
const FAR_FUTURE = "2100-01-01T00:00:00.000Z";

const repository = {
  full_name: OFFICE,
  name: "repofloor",
  default_branch: "main",
  private: false,
  owner: { login: "repofloor", type: "Organization" },
};

const push = (deliveryId: string, commits = 1): GithubWebhook => ({
  event: "push",
  deliveryId,
  payload: {
    repository,
    ref: "refs/heads/main",
    commits: Array.from({ length: commits }, (_, i) => ({ id: `c${i}` })),
    sender: { login: "aliosmanmho" },
  },
});

test("ingesting a delivery keeps the events it applied", async () => {
  const store = new InMemoryOfficeStore();
  const publisher = new InMemoryEventPublisher();

  const result = await ingestWebhook(push("d-1"), { store, publisher });
  const stored = await store.eventsBetween(OFFICE, FAR_PAST, FAR_FUTURE);

  assert.equal(stored.length, result.applied.length);
  assert.deepEqual(stored.map((e) => e.id), result.applied.map((e) => e.id));
});

test("the stored events reproduce the stored snapshot", async () => {
  // The whole point. If these ever disagree, every replay is quietly wrong.
  const store = new InMemoryOfficeStore();
  const publisher = new InMemoryEventPublisher();

  for (let i = 1; i <= 5; i++) await ingestWebhook(push(`d-${i}`, i), { store, publisher });

  const snapshot = (await store.load(OFFICE))!;
  const events = await store.eventsBetween(OFFICE, FAR_PAST, FAR_FUTURE);
  const rebuilt = replay(
    emptyOfficeState(snapshot.building, snapshot.office, snapshot.mode),
    events,
    snapshot.generatedAt,
  );

  assert.deepEqual(
    rebuilt.actors.map((a) => a.actor.id).sort(),
    snapshot.actors.map((a) => a.actor.id).sort(),
  );
});

test("a re-delivery stores nothing twice", async () => {
  const store = new InMemoryOfficeStore();
  const publisher = new InMemoryEventPublisher();

  await ingestWebhook(push("d-same"), { store, publisher });
  await ingestWebhook(push("d-same"), { store, publisher });

  const stored = await store.eventsBetween(OFFICE, FAR_PAST, FAR_FUTURE);
  assert.equal(new Set(stored.map((e) => e.id)).size, stored.length, "no duplicate ids");
});

test("a failed ingest leaves no events behind either", async () => {
  // The history is part of the same unit of work as the snapshot: half-written
  // history is worse than none, because it looks complete.
  const store = new (class extends InMemoryOfficeStore {
    override async save(): Promise<void> {
      throw new Error("connection terminated");
    }
  })();

  await assert.rejects(() => ingestWebhook(push("d-fail"), { store, publisher: new InMemoryEventPublisher() }));
  assert.deepEqual(await store.eventsBetween(OFFICE, FAR_PAST, FAR_FUTURE), []);
});

test("events come back in the order they happened, and only inside the span", async () => {
  const store = new InMemoryOfficeStore();
  const made = (id: string, at: string): OfficeEvent => ({
    id,
    at,
    officeId: OFFICE,
    type: "push",
    actorId: "ali",
    branch: "main",
    commits: 1,
  });

  // Deliberately out of order going in.
  await store.appendEvents(OFFICE, [
    made("c", "2026-10-03T00:00:00.000Z"),
    made("a", "2026-10-01T00:00:00.000Z"),
    made("b", "2026-10-02T00:00:00.000Z"),
  ]);

  assert.deepEqual(
    (await store.eventsBetween(OFFICE, FAR_PAST, FAR_FUTURE)).map((e) => e.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    (await store.eventsBetween(OFFICE, "2026-10-02T00:00:00.000Z", "2026-10-02T23:59:59.000Z")).map((e) => e.id),
    ["b"],
  );
});

test("one office's history is not another's", async () => {
  const store = new InMemoryOfficeStore();
  const publisher = new InMemoryEventPublisher();

  await ingestWebhook(push("d-a"), { store, publisher });
  await ingestWebhook(
    {
      event: "push",
      deliveryId: "d-b",
      payload: {
        repository: { ...repository, full_name: "repofloor/engine", name: "engine" },
        ref: "refs/heads/main",
        commits: [{ id: "x" }],
        sender: { login: "mete" },
      },
    },
    { store, publisher },
  );

  const mine = await store.eventsBetween(OFFICE, FAR_PAST, FAR_FUTURE);
  assert.ok(mine.length > 0);
  assert.ok(mine.every((e) => e.officeId === OFFICE));
});
