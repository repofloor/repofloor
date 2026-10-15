import { strict as assert } from "node:assert";
import { test } from "node:test";
import { emptyOfficeState, type OfficeEvent, type OfficeState } from "@repofloor/protocol";
import { backoffDelay, FIRST_DELAY_MS, MAX_DELAY_MS } from "../src/backoff.js";
import { OfficeLive, type LiveStatus, type SocketLike } from "../src/live.js";
import { CLOSE } from "../src/wire.js";

const state = emptyOfficeState(
  { id: "repofloor", name: "repofloor", kind: "organization" },
  { id: "repofloor/repofloor", buildingId: "repofloor", name: "repofloor" },
  "full",
);

class FakeSocket implements SocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closedWith: number | undefined;

  close(code?: number): void {
    this.closedWith = code;
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop(code: number): void {
    this.onclose?.({ code });
  }
}

interface Harness {
  live: OfficeLive;
  sockets: FakeSocket[];
  statuses: LiveStatus[];
  snapshots: OfficeState[];
  events: OfficeEvent[][];
  /** Run the pending reconnect timer, if any. */
  tick: () => void;
}

function harness(): Harness {
  const sockets: FakeSocket[] = [];
  const statuses: LiveStatus[] = [];
  const snapshots: OfficeState[] = [];
  const events: OfficeEvent[][] = [];
  let pending: (() => void) | null = null;

  const live = new OfficeLive({
    officeId: "repofloor/repofloor",
    base: "ws://realtime.test",
    pageOrigin: "http://page.test",
    random: () => 0.5,
    open: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimeoutImpl: (fn) => {
      pending = fn;
      return 1;
    },
    clearTimeoutImpl: () => {
      pending = null;
    },
    handlers: {
      onSnapshot: (next) => snapshots.push(next),
      onEvents: (batch) => events.push(batch),
      onStatus: (status) => statuses.push(status),
    },
  });

  return {
    live,
    sockets,
    statuses,
    snapshots,
    events,
    tick: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
  };
}

test("the socket url is built from the configured base", () => {
  const h = harness();
  assert.equal(h.live.url, "ws://realtime.test/office/repofloor/repofloor");
});

test("hello is what makes the page live, not the open event", () => {
  const h = harness();
  h.live.start();
  assert.deepEqual(h.statuses, [{ kind: "connecting" }]);

  h.sockets[0]!.onopen?.({});
  assert.deepEqual(h.statuses, [{ kind: "connecting" }]);

  h.sockets[0]!.deliver({ type: "hello", officeId: "repofloor/repofloor", protocolVersion: "1.0.0", viewer: { login: "ali" } });
  assert.deepEqual(h.statuses.at(-1), { kind: "live", viewer: { login: "ali" } });
  h.live.stop();
});

test("snapshots and events reach their handlers; anything else is ignored", () => {
  const h = harness();
  h.live.start();
  const socket = h.sockets[0]!;

  socket.deliver({ type: "snapshot", officeId: "repofloor/repofloor", state });
  socket.deliver({
    type: "events",
    officeId: "repofloor/repofloor",
    events: [{ id: "e1", at: "2026-10-15T10:00:00.000Z", officeId: "repofloor/repofloor", type: "pr.closed", number: 1 }],
  });
  socket.deliver({ type: "pong", at: "2026-10-15T10:00:01.000Z" });
  socket.deliver({ type: "whatever-comes-next" });
  socket.onmessage?.({ data: new Uint8Array([1, 2, 3]) });

  assert.equal(h.snapshots.length, 1);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]?.length, 1);
  h.live.stop();
});

test("a dropped socket is retried, and the retry says when", () => {
  const h = harness();
  h.live.start();
  h.sockets[0]!.drop(1006);

  const status = h.statuses.at(-1);
  assert.equal(status?.kind, "reconnecting");
  assert.ok(status?.kind === "reconnecting" && status.inMs >= FIRST_DELAY_MS);

  h.tick();
  assert.equal(h.sockets.length, 2);
  h.live.stop();
});

test("a refusal ends the loop: retrying it only makes the api authorize us again", () => {
  for (const [code, reason] of [
    [CLOSE.UNAUTHORIZED, "unauthorized"],
    [CLOSE.NOT_FOUND, "not_found"],
    [CLOSE.UNAVAILABLE, "unavailable"],
  ] as const) {
    const h = harness();
    h.live.start();
    h.sockets[0]!.drop(code);
    assert.deepEqual(h.statuses.at(-1), { kind: "refused", reason });
    h.tick();
    assert.equal(h.sockets.length, 1, `${reason} must not reconnect`);
  }
});

test("stop closes the socket cleanly and nothing reconnects after it", () => {
  const h = harness();
  h.live.start();
  const socket = h.sockets[0]!;
  h.live.stop();
  assert.equal(socket.closedWith, 1000);

  socket.drop(1006);
  h.tick();
  assert.equal(h.sockets.length, 1);
});

test("reconnectNow only acts when there is no socket", () => {
  const h = harness();
  h.live.start();
  h.live.reconnectNow();
  assert.equal(h.sockets.length, 1, "a live socket is left alone");

  h.sockets[0]!.drop(1006);
  h.live.reconnectNow();
  assert.equal(h.sockets.length, 2, "a dead socket is replaced at once");
  h.live.stop();
});

test("backoff grows, caps, and never collapses to zero", () => {
  assert.equal(backoffDelay(1, () => 0.5), FIRST_DELAY_MS);
  assert.ok(backoffDelay(4, () => 0.5) > backoffDelay(2, () => 0.5));
  assert.equal(backoffDelay(50, () => 1), MAX_DELAY_MS);
  for (const attempt of [1, 2, 3, 8, 20]) {
    for (const random of [0, 0.5, 0.999]) {
      const delay = backoffDelay(attempt, () => random);
      assert.ok(delay >= FIRST_DELAY_MS && delay <= MAX_DELAY_MS, `${attempt}/${random} → ${delay}`);
    }
  }
});

test("jitter actually spreads the herd", () => {
  const low = backoffDelay(6, () => 0);
  const high = backoffDelay(6, () => 0.999);
  assert.ok(high > low, `${high} should be above ${low}`);
});
