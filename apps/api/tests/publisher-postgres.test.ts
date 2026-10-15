/**
 * `LISTEN`/`NOTIFY` fan-out (ADR 0002): the 8000-byte degradation, a listener that
 * survives a dropped connection, and the resync it reports when it comes back.
 *
 * No database: `Queryable` and the listen connection are both small interfaces, which
 * is the point of having them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyOfficeState, type OfficeEvent, type OfficeState } from "@repofloor/protocol";
import type { QueryResult, Queryable } from "../src/db.ts";
import {
  decodeNotification,
  encodeNotification,
  MAX_NOTIFY_BYTES,
  OFFICE_CHANNEL,
  PostgresEventPublisher,
  PostgresEventSubscriber,
  quoteIdentifier,
  type ListenConnection,
} from "../src/publisher-postgres.ts";

const OFFICE = "repofloor/repofloor";

const state = (): OfficeState =>
  emptyOfficeState(
    { id: "repofloor", name: "repofloor", kind: "organization" },
    { id: OFFICE, buildingId: "repofloor", name: "repofloor", private: false },
    "full",
  );

const pushEvent = (n: number): OfficeEvent => ({
  id: `evt-${n}`,
  at: "2026-10-15T00:00:00.000Z",
  officeId: OFFICE,
  type: "push",
  actorId: "aliosmanmho",
  branch: "main",
  commits: 1,
});

class FakeDb implements Queryable {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  failNext = false;

  async query<R extends object>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
    this.calls.push({ sql, params });
    if (this.failNext) {
      this.failNext = false;
      throw new Error("connection terminated unexpectedly");
    }
    return { rows: [], rowCount: 0 };
  }
}

// ── encoding ────────────────────────────────────────────────────────────────

test("a small update travels whole", () => {
  const payload = encodeNotification({ officeId: OFFICE, events: [pushEvent(1)] });
  const decoded = decodeNotification(payload);
  assert.equal(decoded?.officeId, OFFICE);
  assert.equal(decoded?.events?.length, 1);
  assert.equal(decoded?.events?.[0]?.id, "evt-1");
});

test("an update too large for the channel degrades to a pointer", () => {
  const many = Array.from({ length: 500 }, (_, i) => pushEvent(i));
  const payload = encodeNotification({ officeId: OFFICE, events: many });

  assert.ok(
    Buffer.byteLength(payload, "utf8") <= MAX_NOTIFY_BYTES,
    "the pointer itself must fit, or we have moved the problem",
  );
  const decoded = decodeNotification(payload);
  assert.equal(decoded?.officeId, OFFICE);
  assert.equal(decoded?.events, undefined, "no events means: go and load the snapshot");
});

test("a malformed payload is dropped, not thrown", () => {
  assert.equal(decodeNotification(undefined), undefined);
  assert.equal(decodeNotification(""), undefined);
  assert.equal(decodeNotification("not json"), undefined);
  assert.equal(decodeNotification("[]"), undefined);
  assert.equal(decodeNotification('{"events":[]}'), undefined, "no officeId is not a notification");
  assert.equal(decodeNotification('{"officeId":""}'), undefined);
});

test("identifiers are quoted, including the pathological one", () => {
  assert.equal(quoteIdentifier("repofloor_office"), '"repofloor_office"');
  assert.equal(quoteIdentifier('we"ird'), '"we""ird"');
});

// ── publishing ──────────────────────────────────────────────────────────────

test("publish goes through pg_notify with the channel and payload as parameters", async () => {
  const db = new FakeDb();
  await new PostgresEventPublisher(db).publish({ officeId: OFFICE, events: [pushEvent(1)], state: state() });

  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0]!.sql, /pg_notify/);
  assert.equal(db.calls[0]!.params[0], OFFICE_CHANNEL);
  assert.equal(decodeNotification(String(db.calls[0]!.params[1]))?.officeId, OFFICE);
});

test("a failed notify is logged and swallowed, because the delivery was already saved", async () => {
  const db = new FakeDb();
  db.failNext = true;
  const lines: string[] = [];
  const publisher = new PostgresEventPublisher(db, {
    logger: {
      debug() {},
      info() {},
      warn() {},
      error: (msg) => void lines.push(msg),
      child() {
        return this;
      },
    },
  });

  await publisher.publish({ officeId: OFFICE, events: [pushEvent(1)], state: state() });
  assert.deepEqual(lines, ["notify failed"]);
});

// ── listening ───────────────────────────────────────────────────────────────

/** A connection whose notifications and failures the test drives by hand. */
class FakeConnection implements ListenConnection {
  readonly queries: string[] = [];
  ended = false;
  #notify: ((message: { channel: string; payload?: string }) => void) | undefined;
  #error: ((err: Error) => void) | undefined;

  on(event: "notification" | "error", listener: never): void {
    if (event === "notification") this.#notify = listener;
    else this.#error = listener;
  }

  async query<R extends object>(sql: string): Promise<QueryResult<R>> {
    this.queries.push(sql);
    return { rows: [], rowCount: 0 };
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  emit(payload: string, channel = OFFICE_CHANNEL): void {
    this.#notify?.({ channel, payload });
  }

  drop(): void {
    this.#error?.(new Error("connection terminated unexpectedly"));
  }
}

test("start listens on the channel and delivers decoded notifications", async () => {
  const connection = new FakeConnection();
  const subscriber = new PostgresEventSubscriber({ connect: async () => connection });

  const seen: string[] = [];
  subscriber.onNotification((n) => void seen.push(n.officeId));
  await subscriber.start();

  assert.deepEqual(connection.queries, ['listen "repofloor_office"']);
  connection.emit(encodeNotification({ officeId: OFFICE, events: [pushEvent(1)] }));
  assert.deepEqual(seen, [OFFICE]);

  await subscriber.stop();
  assert.equal(connection.ended, true);
});

test("traffic on another channel, and undecodable traffic, are ignored", async () => {
  const connection = new FakeConnection();
  const subscriber = new PostgresEventSubscriber({ connect: async () => connection });
  const seen: string[] = [];
  subscriber.onNotification((n) => void seen.push(n.officeId));
  await subscriber.start();

  connection.emit(encodeNotification({ officeId: OFFICE, events: [] }), "some_other_channel");
  connection.emit("{{{");
  assert.deepEqual(seen, []);

  await subscriber.stop();
});

test("a dropped connection reconnects and reports a gap", async () => {
  const connections: FakeConnection[] = [];
  const subscriber = new PostgresEventSubscriber({
    connect: async () => {
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    },
    sleep: async () => {},
  });

  let resyncs = 0;
  subscriber.onResync(() => void (resyncs += 1));
  await subscriber.start();
  assert.equal(resyncs, 0, "the first connect is not a gap");

  connections[0]!.drop();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(connections.length, 2, "it reconnected");
  assert.equal(resyncs, 1, "and said it cannot know what it missed");

  // The new connection is the live one.
  const seen: string[] = [];
  subscriber.onNotification((n) => void seen.push(n.officeId));
  connections[1]!.emit(encodeNotification({ officeId: OFFICE }));
  assert.deepEqual(seen, [OFFICE]);

  await subscriber.stop();
});

test("a connect that keeps failing retries with backoff instead of giving up", async () => {
  const delays: number[] = [];
  let attempts = 0;
  const connection = new FakeConnection();

  const subscriber = new PostgresEventSubscriber({
    retryDelaysMs: [10, 20, 40],
    sleep: async (ms) => void delays.push(ms),
    connect: async () => {
      attempts += 1;
      if (attempts < 4) throw new Error("ECONNREFUSED");
      return connection;
    },
  });

  await subscriber.start();
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [10, 20, 40], "backoff grows and then holds at the last step");
  assert.deepEqual(connection.queries, ['listen "repofloor_office"']);

  await subscriber.stop();
});
