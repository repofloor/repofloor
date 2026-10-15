/**
 * The socket edge, over a real `ws` connection against a real `node:http` server.
 *
 * What matters here is the upgrade: an unauthorized client must never become a
 * socket, and the reason it is refused must not leak whether a private office exists.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { emptyOfficeState, type OfficeState } from "@repofloor/protocol";
import type { ConnectAuthorizer, ConnectDecision } from "../src/access.ts";
import { OfficeHub } from "../src/hub.ts";
import { createSocketServer } from "../src/socket.ts";
import type { ServerMessage } from "../src/wire.ts";

const OFFICE = "repofloor/repofloor";

const state = (): OfficeState =>
  emptyOfficeState(
    { id: "repofloor", name: "repofloor", kind: "organization" },
    { id: OFFICE, buildingId: "repofloor", name: "repofloor", private: false },
    "full",
  );

/** Answers from a table keyed by the `authorization` header. */
class FakeAuthorizer implements ConnectAuthorizer {
  readonly asked: string[] = [];
  decision: ConnectDecision = { allowed: true, state: state() };

  async authorize(officeId: string): Promise<ConnectDecision> {
    this.asked.push(officeId);
    return this.decision;
  }
}

interface Harness {
  url: string;
  hub: OfficeHub;
  authorizer: FakeAuthorizer;
}

async function withServer<T>(fn: (h: Harness) => Promise<T>): Promise<T> {
  const hub = new OfficeHub({ snapshots: { load: async () => state() } });
  const authorizer = new FakeAuthorizer();
  const server: Server = createServer((_req, res) => {
    res.writeHead(426);
    res.end();
  });
  const sockets = createSocketServer({ server, hub, authorizer, heartbeatMs: 60_000 });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    return await fn({ url: `ws://127.0.0.1:${port}`, hub, authorizer });
  } finally {
    await sockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Resolves with the frames received, once `count` have arrived. */
function collect(ws: WebSocket, count: number): Promise<ServerMessage[]> {
  return new Promise((resolve, reject) => {
    const frames: ServerMessage[] = [];
    const timer = setTimeout(() => reject(new Error(`only ${frames.length} of ${count} frames`)), 2_000);
    ws.on("message", (raw) => {
      frames.push(JSON.parse(raw.toString()) as ServerMessage);
      if (frames.length >= count) {
        clearTimeout(timer);
        resolve(frames);
      }
    });
    ws.on("error", reject);
  });
}

/** The HTTP status an upgrade was refused with. */
function refusalStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("open", () => {
      ws.close();
      reject(new Error("the upgrade was accepted"));
    });
    ws.on("error", (err) => reject(err));
  });
}

test("an authorized client gets hello and the snapshot", async () => {
  await withServer(async ({ url, hub, authorizer }) => {
    const ws = new WebSocket(`${url}/office/repofloor/repofloor`);
    const frames = await collect(ws, 2);

    assert.deepEqual(
      frames.map((f) => f.type),
      ["hello", "snapshot"],
    );
    assert.deepEqual(authorizer.asked, [OFFICE]);
    assert.equal(hub.clientCount(OFFICE), 1);
    ws.close();
  });
});

test("a refused client never becomes a socket", async () => {
  await withServer(async ({ url, hub, authorizer }) => {
    authorizer.decision = { allowed: false, reason: "unauthenticated" };
    assert.equal(await refusalStatus(`${url}/office/repofloor/repofloor`), 401);

    authorizer.decision = { allowed: false, reason: "not_found" };
    assert.equal(await refusalStatus(`${url}/office/repofloor/secret`), 404);

    authorizer.decision = { allowed: false, reason: "unavailable" };
    assert.equal(await refusalStatus(`${url}/office/repofloor/repofloor`), 503);

    assert.equal(hub.officeCount, 0, "no channel was ever created");
  });
});

test("a path that is not an office is a 404, and the authorizer is never asked", async () => {
  await withServer(async ({ url, authorizer }) => {
    assert.equal(await refusalStatus(`${url}/`), 404);
    assert.equal(await refusalStatus(`${url}/office/repofloor`), 404);
    assert.equal(await refusalStatus(`${url}/offices/a/b`), 404);
    assert.deepEqual(authorizer.asked, []);
  });
});

test("an authorizer that throws refuses the socket rather than admitting it", async () => {
  await withServer(async ({ url, hub, authorizer }) => {
    authorizer.authorize = async () => {
      throw new Error("api unreachable");
    };
    assert.equal(await refusalStatus(`${url}/office/repofloor/repofloor`), 503);
    assert.equal(hub.officeCount, 0);
  });
});

test("a ping is answered with a pong", async () => {
  await withServer(async ({ url }) => {
    const ws = new WebSocket(`${url}/office/repofloor/repofloor`);
    await collect(ws, 2);

    const pong = new Promise<ServerMessage>((resolve) => {
      ws.on("message", (raw) => resolve(JSON.parse(raw.toString()) as ServerMessage));
    });
    ws.send(JSON.stringify({ type: "ping" }));
    assert.equal((await pong).type, "pong");
    ws.close();
  });
});

test("a frame we do not understand is ignored, not fatal", async () => {
  await withServer(async ({ url, hub }) => {
    const ws = new WebSocket(`${url}/office/repofloor/repofloor`);
    await collect(ws, 2);

    ws.send("not json at all");
    ws.send(JSON.stringify({ type: "drop table" }));
    ws.send(Buffer.from([0x00, 0x01, 0x02]));
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(hub.clientCount(OFFICE), 1, "still connected");
    ws.close();
  });
});

test("events reach a live socket", async () => {
  await withServer(async ({ url, hub }) => {
    const ws = new WebSocket(`${url}/office/repofloor/repofloor`);
    await collect(ws, 2);

    const next = new Promise<ServerMessage>((resolve) => {
      ws.on("message", (raw) => resolve(JSON.parse(raw.toString()) as ServerMessage));
    });
    await hub.deliver(OFFICE, [
      { id: "e1", at: "2026-10-15T09:00:00.000Z", officeId: OFFICE, type: "pr.closed", number: 7 },
    ]);

    const frame = await next;
    assert.equal(frame.type, "events");
    ws.close();
  });
});

test("closing the socket removes the client from the hub", async () => {
  await withServer(async ({ url, hub }) => {
    const ws = new WebSocket(`${url}/office/repofloor/repofloor`);
    await collect(ws, 2);
    assert.equal(hub.clientCount(OFFICE), 1);

    await new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
      ws.close();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(hub.clientCount(OFFICE), 0);
  });
});
