/**
 * Ingest is one unit of work.
 *
 * The bug this guards against: `markDelivered` says "applied", then `save` fails or
 * the process dies, and the event is lost for good — GitHub's re-delivery is deduped
 * away by the ledger entry that outlived the snapshot it was supposed to produce.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestWebhook } from "../src/ingest.ts";
import { InMemoryEventPublisher } from "../src/publisher.ts";
import { InMemoryOfficeStore, withOfficeTransaction, type OfficeStore } from "../src/store.ts";
import type { GithubWebhook } from "@repofloor/reducer";

const OFFICE = "repofloor/repofloor";

const push = (deliveryId: string): GithubWebhook => ({
  event: "push",
  deliveryId,
  payload: {
    repository: {
      full_name: OFFICE,
      name: "repofloor",
      default_branch: "main",
      private: false,
      owner: { login: "repofloor", type: "Organization" },
    },
    ref: "refs/heads/main",
    commits: [{ id: "a" }],
    sender: { login: "aliosmanmho" },
  },
});

/** An in-memory store whose `save` fails once, the way a dying connection would. */
class FailingSaveStore extends InMemoryOfficeStore {
  failNextSave = true;
  override async save(officeId: string, state: Parameters<OfficeStore["save"]>[1]): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("connection terminated");
    }
    return super.save(officeId, state);
  }
}

test("a save that fails leaves no event marked delivered, so the re-delivery still applies", async () => {
  const store = new FailingSaveStore();
  const publisher = new InMemoryEventPublisher();

  await assert.rejects(() => ingestWebhook(push("d-1"), { store, publisher }), /connection terminated/);

  // Nothing was published, and the ledger was rolled back with the snapshot.
  assert.equal(publisher.published.length, 0);
  assert.deepEqual(await store.list(), []);

  const result = await ingestWebhook(push("d-1"), { store, publisher });
  assert.ok(result.applied.length > 0, "the same delivery applies on the retry");
  assert.deepEqual(await store.list(), [OFFICE]);
  assert.equal(publisher.published.length, 1);
});

test("a duplicate delivery is still a no-op, transaction or not", async () => {
  const store = new InMemoryOfficeStore();
  const publisher = new InMemoryEventPublisher();

  const first = await ingestWebhook(push("d-2"), { store, publisher });
  const second = await ingestWebhook(push("d-2"), { store, publisher });

  assert.ok(first.applied.length > 0);
  assert.deepEqual(second.applied, []);
  assert.equal(publisher.published.length, 1, "nothing is announced twice");
});

test("publishing happens after the transaction, never inside it", async () => {
  const store = new InMemoryOfficeStore();
  const publisher = new InMemoryEventPublisher();
  let open = false;

  const watched: OfficeStore = {
    load: (id) => store.load(id),
    save: (id, state) => store.save(id, state),
    markDelivered: (id) => store.markDelivered(id),
    list: () => store.list(),
    async transaction(key, fn) {
      open = true;
      try {
        return await fn(this);
      } finally {
        open = false;
      }
    },
  };
  publisher.subscribe(() => assert.equal(open, false, "published while the transaction was open"));

  const result = await ingestWebhook(push("d-3"), { store: watched, publisher });
  assert.ok(result.applied.length > 0);
  assert.equal(publisher.published.length, 1);
});

test("withOfficeTransaction runs inline against a store that offers none", async () => {
  const plain: OfficeStore = {
    load: async () => undefined,
    save: async () => {},
    markDelivered: async () => true,
    list: async () => [],
  };
  assert.equal(await withOfficeTransaction(plain, OFFICE, async (s) => s === plain), true);
});
