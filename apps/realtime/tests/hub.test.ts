/**
 * The hub: what each client is sent, and when.
 *
 * No sockets here — the hub's `Client` is "something you can send a string to", which
 * is exactly so this can be tested without a network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyOfficeState, PROTOCOL_VERSION, type OfficeEvent, type OfficeState } from "@repofloor/protocol";
import { OfficeHub, type Client, type SnapshotSource } from "../src/hub.ts";
import type { ServerMessage } from "../src/wire.ts";

const OFFICE = "repofloor/repofloor";
const OTHER = "repofloor/engine";

function state(actorIds: string[] = []): OfficeState {
  const base = emptyOfficeState(
    { id: "repofloor", name: "repofloor", kind: "organization" },
    { id: OFFICE, buildingId: "repofloor", name: "repofloor", private: false },
    "full",
  );
  return {
    ...base,
    actors: actorIds.map((id) => ({
      actor: { id, kind: "human" as const },
      status: "coding" as const,
      lastSeen: "2026-10-15T09:00:00.000Z",
    })),
  };
}

const pushEvent: OfficeEvent = {
  id: "evt-1",
  at: "2026-10-15T09:00:00.000Z",
  officeId: OFFICE,
  type: "push",
  actorId: "ali",
  branch: "main",
  commits: 2,
};

/** Records every frame, decoded. */
class FakeClient implements Client {
  readonly received: ServerMessage[] = [];
  closed: { code: number; reason?: string } | undefined;

  send(data: string): void {
    this.received.push(JSON.parse(data) as ServerMessage);
  }

  close(code: number, reason?: string): void {
    this.closed = reason === undefined ? { code } : { code, reason };
  }

  typesSeen(): string[] {
    return this.received.map((m) => m.type);
  }

  last(): ServerMessage | undefined {
    return this.received.at(-1);
  }
}

class FakeSnapshots implements SnapshotSource {
  calls = 0;
  constructor(private snapshot: OfficeState | undefined) {}
  async load(): Promise<OfficeState | undefined> {
    this.calls += 1;
    return this.snapshot;
  }
  set(snapshot: OfficeState | undefined): void {
    this.snapshot = snapshot;
  }
}

const hubWith = (snapshots: SnapshotSource) =>
  new OfficeHub({ snapshots, now: () => "2026-10-15T09:00:00.000Z" });

test("a joining client is greeted, then given the snapshot", () => {
  const hub = hubWith(new FakeSnapshots(state()));
  const client = new FakeClient();
  hub.join(OFFICE, client, state());

  assert.deepEqual(client.typesSeen(), ["hello", "snapshot"]);
  const hello = client.received[0];
  assert.equal(hello?.type === "hello" ? hello.protocolVersion : undefined, PROTOCOL_VERSION);
  assert.equal(hello?.type === "hello" ? hello.officeId : undefined, OFFICE);
});

test("events are forwarded to everyone on that office, and nobody else", async () => {
  const hub = hubWith(new FakeSnapshots(state()));
  const a = new FakeClient();
  const b = new FakeClient();
  const elsewhere = new FakeClient();

  hub.join(OFFICE, a, state());
  hub.join(OFFICE, b, state());
  hub.join(OTHER, elsewhere, state());

  await hub.deliver(OFFICE, [pushEvent]);

  for (const client of [a, b]) {
    const last = client.last();
    assert.equal(last?.type, "events");
    assert.deepEqual(last?.type === "events" ? last.events : [], [pushEvent]);
  }
  assert.deepEqual(elsewhere.typesSeen(), ["hello", "snapshot"], "a different office hears nothing");
});

test("a notification with no events loads the snapshot instead", async () => {
  const snapshots = new FakeSnapshots(state(["ali"]));
  const hub = hubWith(snapshots);
  const client = new FakeClient();
  hub.join(OFFICE, client, state());

  await hub.deliver(OFFICE, undefined);

  assert.equal(snapshots.calls, 1);
  assert.equal(client.last()?.type, "snapshot");
});

test("nothing is loaded or sent for an office nobody is watching", async () => {
  const snapshots = new FakeSnapshots(state());
  const hub = hubWith(snapshots);

  await hub.deliver(OFFICE, undefined);
  await hub.deliver(OFFICE, [pushEvent]);

  assert.equal(snapshots.calls, 0);
  assert.equal(hub.officeCount, 0);
});

test("a resync that finds no snapshot sends nothing rather than something wrong", async () => {
  const snapshots = new FakeSnapshots(undefined);
  const hub = hubWith(snapshots);
  const client = new FakeClient();
  hub.join(OFFICE, client, state());

  await hub.resync(OFFICE);
  assert.deepEqual(client.typesSeen(), ["hello", "snapshot"], "no second snapshot");
});

test("resyncAll reaches every live office", async () => {
  const hub = hubWith(new FakeSnapshots(state()));
  const a = new FakeClient();
  const b = new FakeClient();
  hub.join(OFFICE, a, state());
  hub.join(OTHER, b, state());

  await hub.resyncAll();

  assert.equal(a.last()?.type, "snapshot");
  assert.equal(b.last()?.type, "snapshot");
});

test("an office is forgotten once its last client leaves", () => {
  const hub = hubWith(new FakeSnapshots(state()));
  const client = new FakeClient();
  const leave = hub.join(OFFICE, client, state());

  assert.equal(hub.officeCount, 1);
  leave();
  assert.equal(hub.officeCount, 0);
  assert.equal(hub.clientCount(OFFICE), 0);
});

test("a named viewer appears to the others, and is gone when they leave", () => {
  const hub = hubWith(new FakeSnapshots(state()));
  const watcher = new FakeClient();
  hub.join(OFFICE, watcher, state());

  const ali = new FakeClient();
  const leave = hub.join(OFFICE, ali, state(), { login: "ali" });

  const arrival = watcher.last();
  assert.equal(arrival?.type, "events");
  assert.equal(arrival?.type === "events" ? arrival.events[0]?.type : undefined, "actor.upsert");
  assert.deepEqual(
    hub.viewers(OFFICE).map((a) => a.id),
    ["ali"],
  );

  leave();
  const departure = watcher.last();
  assert.equal(departure?.type === "events" ? departure.events[0]?.type : undefined, "actor.leave");
  assert.deepEqual(hub.viewers(OFFICE), []);
});

test("a viewer GitHub already places in the office is not marked offline on leaving", () => {
  // The snapshot says ali is coding: he pushed. Closing the tab must not contradict it.
  const hub = hubWith(new FakeSnapshots(state(["ali"])));
  const watcher = new FakeClient();
  hub.join(OFFICE, watcher, state(["ali"]));
  const leave = hub.join(OFFICE, new FakeClient(), state(["ali"]), { login: "ali" });

  const framesBefore = watcher.received.length;
  leave();
  assert.equal(watcher.received.length, framesBefore, "no actor.leave was broadcast");
});

test("a late arrival is told who is already on the floor", () => {
  const hub = hubWith(new FakeSnapshots(state()));
  hub.join(OFFICE, new FakeClient(), state(), { login: "ali" });

  const late = new FakeClient();
  hub.join(OFFICE, late, state(), { login: "mete" });

  assert.deepEqual(late.typesSeen().slice(0, 3), ["hello", "snapshot", "events"]);
  const roster = late.received[2];
  assert.deepEqual(
    roster?.type === "events" ? roster.events.map((e) => (e.type === "actor.upsert" ? e.actor.id : "?")) : [],
    ["ali"],
  );
});

test("an anonymous client sees others but puts nobody on the floor", () => {
  const hub = hubWith(new FakeSnapshots(state()));
  const anon = new FakeClient();
  hub.join(OFFICE, anon, state());

  assert.deepEqual(hub.viewers(OFFICE), []);
  const hello = anon.received[0];
  assert.equal(hello?.type === "hello" ? hello.viewer : undefined, undefined);
});

test("expirePresence removes a viewer whose socket went quiet", () => {
  let now = 1_000_000;
  const hub = new OfficeHub({
    snapshots: new FakeSnapshots(state()),
    presence: { ttlMs: 1_000, now: () => now },
    now: () => "2026-10-15T09:00:00.000Z",
  });
  const watcher = new FakeClient();
  hub.join(OFFICE, watcher, state());
  hub.join(OFFICE, new FakeClient(), state(), { login: "ali" });

  now += 5_000;
  hub.expirePresence();

  assert.deepEqual(hub.viewers(OFFICE), []);
  const last = watcher.last();
  assert.equal(last?.type === "events" ? last.events[0]?.type : undefined, "actor.leave");
});

test("a client whose send throws does not stop the others being updated", async () => {
  const hub = hubWith(new FakeSnapshots(state()));
  const broken: Client = {
    send() {
      throw new Error("EPIPE");
    },
    close() {},
  };
  hub.join(OFFICE, broken, state());
  const healthy = new FakeClient();
  hub.join(OFFICE, healthy, state());

  await hub.deliver(OFFICE, [pushEvent]);
  assert.equal(healthy.last()?.type, "events");
});

test("closeAll says goodbye to everyone", () => {
  const hub = hubWith(new FakeSnapshots(state()));
  const client = new FakeClient();
  hub.join(OFFICE, client, state());

  hub.closeAll();
  assert.equal(client.closed?.code, 1001);
  assert.equal(hub.officeCount, 0);
});
