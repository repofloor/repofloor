/**
 * The client's view of what `apps/realtime` sends.
 *
 * The server's own definition is `apps/realtime/src/wire.ts`, which is the source of
 * truth; this is a narrower copy rather than an import, because a browser bundle must
 * not depend on a server package (`ws`, `pg`, the api's session code). The two can
 * drift, so nothing here trusts the shape: every frame is validated, and a frame we do
 * not understand is ignored instead of crashing the page.
 *
 * Rule 1 is why this file is so small: the only payloads that cross are `OfficeState`
 * and `OfficeEvent`, so there is nothing to translate before the engine sees them.
 */

import { assertOfficeState, type OfficeEvent, type OfficeState } from "@repofloor/protocol";

export interface Viewer {
  login: string;
  avatarUrl?: string;
}

export type ServerMessage =
  | { type: "hello"; officeId: string; protocolVersion: string; viewer?: Viewer }
  | { type: "snapshot"; officeId: string; state: OfficeState }
  | { type: "events"; officeId: string; events: OfficeEvent[] }
  | { type: "pong"; at: string }
  | { type: "error"; error: string };

export const CLOSE = {
  UNAUTHORIZED: 4001,
  NOT_FOUND: 4004,
  UNAVAILABLE: 4003,
  BAD_REQUEST: 4000,
  GOING_AWAY: 1001,
} as const;

/** Parse one frame. `undefined` for anything unrecognised — including a newer frame type. */
export function parseServerMessage(raw: string): ServerMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const frame = parsed as Record<string, unknown>;

  switch (frame["type"]) {
    case "hello": {
      const officeId = frame["officeId"];
      const protocolVersion = frame["protocolVersion"];
      if (typeof officeId !== "string" || typeof protocolVersion !== "string") return undefined;
      const viewer = parseViewer(frame["viewer"]);
      return { type: "hello", officeId, protocolVersion, ...(viewer ? { viewer } : {}) };
    }
    case "snapshot": {
      const officeId = frame["officeId"];
      if (typeof officeId !== "string") return undefined;
      try {
        assertOfficeState(frame["state"]);
      } catch {
        return undefined;
      }
      return { type: "snapshot", officeId, state: frame["state"] };
    }
    case "events": {
      const officeId = frame["officeId"];
      const events = frame["events"];
      if (typeof officeId !== "string" || !Array.isArray(events)) return undefined;
      const valid = events.filter(isEventish);
      if (valid.length === 0) return undefined;
      return { type: "events", officeId, events: valid };
    }
    case "pong": {
      const at = frame["at"];
      return typeof at === "string" ? { type: "pong", at } : undefined;
    }
    case "error": {
      const error = frame["error"];
      return typeof error === "string" ? { type: "error", error } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Enough of an event to hand to the reducer and the renderer: the reducer switches on
 * `type` and ignores what it does not know, so the fields each variant needs are its
 * own business. `id`, `at` and `officeId` are the ones every path here reads.
 */
function isEventish(value: unknown): value is OfficeEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["type"] === "string" && typeof v["id"] === "string" && typeof v["at"] === "string";
}

function parseViewer(value: unknown): Viewer | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v["login"] !== "string") return undefined;
  const avatarUrl = v["avatarUrl"];
  return { login: v["login"], ...(typeof avatarUrl === "string" ? { avatarUrl } : {}) };
}

/** What a close code means to the page. Anything else is "try again". */
export function closeMeaning(code: number): "unauthorized" | "not_found" | "unavailable" | "retry" {
  switch (code) {
    case CLOSE.UNAUTHORIZED:
      return "unauthorized";
    case CLOSE.NOT_FOUND:
      return "not_found";
    case CLOSE.UNAVAILABLE:
      return "unavailable";
    default:
      return "retry";
  }
}
