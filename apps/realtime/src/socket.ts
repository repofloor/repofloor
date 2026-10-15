/**
 * The WebSocket edge: `ws` on one side, the hub on the other.
 *
 * `ws` is wrapped rather than used directly throughout (ADR 0002) so it stays
 * replaceable, the way `pg` sits behind `Queryable`. Everything below the upgrade is
 * the hub's `Client` interface, which a plain object satisfies.
 *
 * The upgrade is the only place authorization happens, and it happens *before* the
 * handshake completes: a refused client never becomes a socket, it gets an HTTP error
 * and the connection is destroyed. Admitting first and closing after would mean a
 * window in which an unauthorized socket exists.
 */

import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { errorFields, silentLogger, type Logger } from "@repofloor/api";
import type { ConnectAuthorizer } from "./access.js";
import type { OfficeHub } from "./hub.js";
import { CLOSE, decodeClientMessage, encode, officeIdFromPath } from "./wire.js";

export interface SocketServerOptions {
  server: HttpServer;
  hub: OfficeHub;
  authorizer: ConnectAuthorizer;
  logger?: Logger | undefined;
  /**
   * How often every socket is pinged. A socket that has not answered the previous
   * ping is terminated: that is what keeps presence honest when a laptop closes
   * without a close frame. Default 30s.
   */
  heartbeatMs?: number | undefined;
  now?: (() => string) | undefined;
}

export const DEFAULT_HEARTBEAT_MS = 30_000;

/** Refuse an upgrade at the HTTP layer, before a socket exists. */
function refuse(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
  socket.destroy();
}

const STATUS: Record<string, [number, string]> = {
  unauthenticated: [401, "Unauthorized"],
  not_found: [404, "Not Found"],
  unavailable: [503, "Service Unavailable"],
};

export interface SocketServer {
  /** Stop pinging, close every socket, and stop accepting upgrades. */
  close(): Promise<void>;
}

export function createSocketServer(options: SocketServerOptions): SocketServer {
  const { server, hub, authorizer } = options;
  const log = options.logger ?? silentLogger;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  // `noServer`: we own the upgrade, because authorization has to run first.
  const wss = new WebSocketServer({ noServer: true });
  /** Sockets that have answered the most recent ping. */
  const alive = new WeakSet<WebSocket>();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void handleUpgrade(req, socket, head);
  });

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const officeId = officeIdFromPath(url.pathname);
    if (!officeId) return refuse(socket, 404, "Not Found");

    let decision;
    try {
      decision = await authorizer.authorize(officeId, req);
    } catch (err) {
      log.error("authorize threw during upgrade", { officeId, ...errorFields(err) });
      return refuse(socket, 503, "Service Unavailable");
    }

    if (!decision.allowed) {
      const [status, reason] = STATUS[decision.reason] ?? [403, "Forbidden"];
      log.info("socket refused", { officeId, reason: decision.reason, status });
      return refuse(socket, status, reason);
    }

    // The client went away while we were asking.
    if (socket.destroyed) return;

    // Narrowed here, where it still is: the closure below outlives the guard.
    const { state, viewer } = decision;

    wss.handleUpgrade(req, socket, head, (ws) => {
      alive.add(ws);

      const leave = hub.join(
        officeId,
        {
          send: (data) => ws.send(data),
          close: (code, closeReason) => ws.close(code, closeReason),
        },
        state,
        viewer,
      );

      log.info("socket open", {
        officeId,
        ...(viewer ? { viewer: viewer.login } : {}),
        clients: hub.clientCount(officeId),
      });

      ws.on("pong", () => {
        alive.add(ws);
        hub.touch(officeId, viewer);
      });

      ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        // Nothing we speak is binary, and decoding an arbitrary blob is work an
        // unauthenticated-shaped client should not be able to make us do.
        if (isBinary) return;
        const message = decodeClientMessage(raw.toString());
        if (!message) return;
        hub.touch(officeId, viewer);
        ws.send(encode({ type: "pong", at: (options.now ?? (() => new Date().toISOString()))() }));
      });

      ws.on("close", () => {
        leave();
        log.info("socket closed", { officeId, clients: hub.clientCount(officeId) });
      });

      ws.on("error", (err: Error) => {
        log.debug("socket error", errorFields(err));
        ws.terminate();
      });
    });
  }

  /**
   * Ping every socket; terminate the ones that did not answer the last round. This,
   * not a timer on the client, is what expires presence for a laptop that closed.
   */
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
    hub.expirePresence();
  }, heartbeatMs);
  heartbeat.unref();

  return {
    async close(): Promise<void> {
      clearInterval(heartbeat);
      hub.closeAll();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
