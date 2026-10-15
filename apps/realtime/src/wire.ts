/**
 * What travels over the socket.
 *
 * Rule 1 shapes this file: the engine never learns where its data came from, so the
 * only payloads here are `OfficeState` and `OfficeEvent`. Everything else is framing —
 * which office, and whether this frame is a full state or a list of events.
 *
 * `snapshot` means "replace what you have" (`OfficeRenderer.setState`); `events` means
 * "animate these" (`applyEffect`). A client that only ever handled `snapshot` would
 * still be correct, just less alive.
 */

import type { OfficeEvent, OfficeState } from "@repofloor/protocol";

export type ServerMessage =
  /** First frame on every connection: who you are to us, and what we speak. */
  | { type: "hello"; officeId: string; protocolVersion: string; viewer?: Viewer }
  /** Replace local state wholesale. Sent at connect, and after any gap. */
  | { type: "snapshot"; officeId: string; state: OfficeState }
  /** Apply these in order. The animated path. */
  | { type: "events"; officeId: string; events: OfficeEvent[] }
  /** Answer to a client `ping`, so a browser can measure its own liveness. */
  | { type: "pong"; at: string }
  /** Sent immediately before the server closes the connection. */
  | { type: "error"; error: string };

export type ClientMessage = { type: "ping" };

/** Who is watching, as far as presence is concerned. Never a token, never a duration. */
export interface Viewer {
  /** GitHub login; this is also the actor id on the floor. */
  login: string;
  avatarUrl?: string;
}

/**
 * Close codes. 4000+ is the application range reserved by RFC 6455.
 *
 * `UNAUTHORIZED` and `NOT_FOUND` deliberately differ from the HTTP side, where both
 * answer `404` so that the existence of a private repo stays private. Here the client
 * has already been told nothing it did not know: the close happens on a URL it chose,
 * and it learns only that it cannot have it. We still never say *why*.
 */
export const CLOSE = {
  UNAUTHORIZED: 4001,
  NOT_FOUND: 4004,
  UNAVAILABLE: 4003,
  BAD_REQUEST: 4000,
  GOING_AWAY: 1001,
} as const;

export function encode(message: ServerMessage): string {
  return JSON.stringify(message);
}

/**
 * Parse a frame from a client. Returns undefined for anything we do not understand —
 * a browser on an older build must not be able to crash the server with a typo.
 */
export function decodeClientMessage(raw: string): ClientMessage | undefined {
  if (raw.length > 4096) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return (parsed as Record<string, unknown>)["type"] === "ping" ? { type: "ping" } : undefined;
}

/**
 * GitHub's own rules: an owner is alphanumeric with hyphens, a repository name also
 * allows `.` and `_`. Anything else is not a repository we could have a snapshot of.
 */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9._-]+$/;

/**
 * `/office/:owner/:repo` → `"owner/repo"`, or undefined when the path is not one.
 *
 * The segments are validated *after* decoding, which is the whole point: `%2F` decodes
 * to a slash, so `/office/a%2Fb/c` would otherwise yield the three-segment id `a/b/c`
 * — and a client could then be authorized for `a/b` while joining a channel named
 * something no notification will ever match.
 */
export function officeIdFromPath(pathname: string): string | undefined {
  const match = pathname.replace(/\/+$/, "").match(/^\/office\/([^/]+)\/([^/]+)$/);
  if (!match) return undefined;

  let owner: string;
  let repo: string;
  try {
    owner = decodeURIComponent(match[1]!);
    repo = decodeURIComponent(match[2]!);
  } catch {
    // A malformed escape sequence throws; it is not a path we serve either way.
    return undefined;
  }

  if (!OWNER.test(owner) || !REPO.test(repo)) return undefined;
  return `${owner}/${repo}`;
}
