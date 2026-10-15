/**
 * The socket, as a state machine with four callbacks.
 *
 * What it owes the page: a `snapshot` replaces local state wholesale, `events` animate
 * and advance it, and a reconnect is invisible except for the indicator. The server
 * sends a snapshot on every connect, so a reconnect needs no catch-up logic here —
 * which is why the reconnect loop can be this plain.
 *
 * What it refuses to do: decide anything about access. A `4001` or `4004` close ends
 * the loop and is reported upward, where the only honest response is to offer sign-in
 * (rule 6 — there is no second ACL in this process either).
 */

import type { OfficeEvent, OfficeState } from "@repofloor/protocol";
import { backoffDelay } from "./backoff.js";
import { socketUrl } from "./endpoints.js";
import { closeMeaning, parseServerMessage, type Viewer } from "./wire.js";

export type LiveStatus =
  | { kind: "connecting" }
  | { kind: "live"; viewer: Viewer | undefined }
  | { kind: "reconnecting"; inMs: number }
  /** Terminal: the server will not let this page in, and retrying will not change that. */
  | { kind: "refused"; reason: "unauthorized" | "not_found" | "unavailable" };

export interface LiveHandlers {
  onSnapshot: (state: OfficeState) => void;
  onEvents: (events: OfficeEvent[]) => void;
  onStatus: (status: LiveStatus) => void;
}

/** Anything that behaves like a browser `WebSocket`. Injected in tests. */
export interface SocketLike {
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface OfficeLiveOptions {
  officeId: string;
  handlers: LiveHandlers;
  /** Defaults to `REALTIME_URL` from config. */
  base?: string;
  pageOrigin?: string;
  open?: (url: string) => SocketLike;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  random?: () => number;
}

export class OfficeLive {
  readonly #url: string;
  readonly #handlers: LiveHandlers;
  readonly #open: (url: string) => SocketLike;
  readonly #setTimeout: (fn: () => void, ms: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;
  readonly #random: () => number;

  #socket: SocketLike | null = null;
  #timer: unknown = null;
  #attempt = 0;
  #stopped = false;

  constructor(options: OfficeLiveOptions) {
    const origin = options.pageOrigin ?? (typeof location === "undefined" ? "" : location.origin);
    this.#url = socketUrl(options.base ?? "", options.officeId, origin);
    this.#handlers = options.handlers;
    this.#open = options.open ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.#setTimeout = options.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimeout = options.clearTimeoutImpl ?? ((handle) => clearTimeout(handle as number));
    this.#random = options.random ?? Math.random;
  }

  get url(): string {
    return this.#url;
  }

  start(): void {
    if (this.#stopped) return;
    this.#connect();
  }

  /** Called when the tab comes back: a laptop that slept has a dead socket. */
  reconnectNow(): void {
    if (this.#stopped || this.#socket) return;
    this.#clearTimer();
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearTimer();
    const socket = this.#socket;
    this.#socket = null;
    // 1000 with no reason: a page navigating away is not an error.
    socket?.close(1000);
  }

  #connect(): void {
    this.#handlers.onStatus({ kind: "connecting" });

    let socket: SocketLike;
    try {
      socket = this.#open(this.#url);
    } catch {
      // A browser refuses to open a socket from https: to ws:, among other reasons.
      this.#scheduleRetry();
      return;
    }
    this.#socket = socket;

    socket.onopen = () => {
      this.#attempt = 0;
      // Not "live" yet: the server's `hello` is what says we are in. Until then the
      // indicator stays on "connecting", which is the truth.
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const message = parseServerMessage(event.data);
      if (!message) return;
      switch (message.type) {
        case "hello":
          this.#handlers.onStatus({ kind: "live", viewer: message.viewer });
          return;
        case "snapshot":
          this.#handlers.onSnapshot(message.state);
          return;
        case "events":
          this.#handlers.onEvents(message.events);
          return;
        case "pong":
        case "error":
          return;
      }
    };

    socket.onerror = () => {
      // `onclose` always follows; nothing to do but let it.
    };

    socket.onclose = (event) => {
      this.#socket = null;
      if (this.#stopped) return;
      const meaning = closeMeaning(event.code);
      if (meaning !== "retry") {
        // Terminal. Retrying a refusal only makes the api authorize us again.
        this.#handlers.onStatus({ kind: "refused", reason: meaning });
        this.#stopped = true;
        return;
      }
      this.#scheduleRetry();
    };
  }

  #scheduleRetry(): void {
    this.#attempt += 1;
    const inMs = backoffDelay(this.#attempt, this.#random);
    this.#handlers.onStatus({ kind: "reconnecting", inMs });
    this.#timer = this.#setTimeout(() => {
      this.#timer = null;
      if (!this.#stopped) this.#connect();
    }, inMs);
  }

  #clearTimer(): void {
    if (this.#timer !== null) this.#clearTimeout(this.#timer);
    this.#timer = null;
  }
}
