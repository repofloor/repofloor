/**
 * Words for things the canvas draws as pixels.
 *
 * Two readers are served by the same functions. One is the status strip and activity
 * log under the canvas, items 3 and 4 of `docs/VISUAL_TARGET.md`. The other is anybody
 * who cannot use the canvas at all (issue #15): the strip plus the log *is* the office,
 * in text, and it is in the DOM rather than inside a WebGL context.
 *
 * Pure, and free of the DOM, so it is testable — and so the office page is the only
 * file that knows what an element is.
 */

import type { ActivityStatus, Actor, ActorState, OfficeEvent, OfficeState } from "@repofloor/protocol";

/** What the reducer's statuses mean in a sentence. Keep in sync with `docs/PROTOCOL.md`. */
export const STATUS_LABEL: Record<ActivityStatus, string> = {
  offline: "away",
  idle: "at their desk",
  coding: "writing code",
  reviewing: "reviewing",
  discussing: "in a discussion",
  building: "waiting on CI",
  blocked: "blocked",
  celebrating: "celebrating a merge",
  in_room: "in a room",
  focus: "in focus mode",
};

/** One per status, so a row reads at a glance. Not meaning-bearing: the label is. */
export const STATUS_ICON: Record<ActivityStatus, string> = {
  offline: "·",
  idle: "○",
  coding: "⌨",
  reviewing: "👀",
  discussing: "💬",
  building: "⚙",
  blocked: "⛔",
  celebrating: "🎉",
  in_room: "🚪",
  focus: "🎧",
};

export function actorDisplayName(actor: Actor): string {
  if (actor.name) return actor.name;
  // Agent ids are `agent:<owner>:<name>`; the name is the part people recognise.
  if (actor.kind === "agent") return actor.id.split(":").slice(2).join(":") || actor.id;
  return actor.id;
}

export interface StripRow {
  id: string;
  /** `name · emoji · what they are doing`, as the visual target puts it. */
  name: string;
  emoji: string;
  status: ActivityStatus;
  label: string;
  icon: string;
  detail: string | undefined;
  link: string | undefined;
  kind: Actor["kind"];
  /** Which room, by its display name, when they are not on the open floor. */
  room: string | undefined;
}

/**
 * The strip, in the order it should be read: busiest first, away last, and within a
 * group the most recently seen first. Deliberately *not* the desk order — the floor is
 * laid out by `hash(login)` so that it is stable, which is the opposite of what a
 * reader wants from a list.
 */
export function stripRows(state: OfficeState): StripRow[] {
  const rooms = new Map(state.rooms.map((r) => [r.id, r.name]));
  return [...state.actors]
    .sort((a, b) => rank(a.status) - rank(b.status) || b.lastSeen.localeCompare(a.lastSeen))
    .map((a) => ({
      id: a.actor.id,
      name: actorDisplayName(a.actor),
      emoji: a.actor.emoji ?? (a.actor.kind === "agent" ? "🤖" : a.actor.kind === "bot" ? "⚙" : ""),
      status: a.status,
      label: STATUS_LABEL[a.status],
      icon: STATUS_ICON[a.status],
      detail: a.detail,
      link: a.link,
      kind: a.actor.kind,
      room: a.roomId ? rooms.get(a.roomId) ?? a.roomId.split("#")[1] : undefined,
    }));
}

/** Away sinks, everything active floats. Within a rank, recency decides. */
function rank(status: ActivityStatus): number {
  if (status === "offline") return 3;
  if (status === "idle") return 2;
  return 1;
}

/** A one-line summary of the floor, for the page's heading and its `<title>`. */
export function summarize(state: OfficeState): string {
  const active = state.actors.filter((a) => a.status !== "offline").length;
  const agents = state.actors.filter((a) => a.actor.kind === "agent" && a.status !== "offline").length;
  if (active === 0) return "nobody on the floor";
  const people = active - agents;
  const parts: string[] = [];
  if (people > 0) parts.push(`${people} ${people === 1 ? "person" : "people"}`);
  if (agents > 0) parts.push(`${agents} ${agents === 1 ? "agent" : "agents"}`);
  return `${parts.join(" · ")} on the floor`;
}

export interface LogLine {
  id: string;
  at: string;
  /** The actor this is about, as a display id. Empty when the event is about the office. */
  who: string;
  text: string;
  link: string | undefined;
}

/**
 * One event as a line of the activity log. Every variant of the union is covered, so a
 * new event type is a type error here rather than a silent blank row.
 */
export function describeEvent(event: OfficeEvent, state?: OfficeState): LogLine {
  const line = (who: string, text: string, link?: string): LogLine => ({
    id: event.id,
    at: event.at,
    who: who ? displayId(who, state) : "",
    text,
    link,
  });

  switch (event.type) {
    case "snapshot":
      return line("", "office reloaded");
    case "actor.upsert":
      return line(event.actor.id, "arrived");
    case "actor.status":
      return line(event.actorId, [STATUS_LABEL[event.status], event.detail].filter(Boolean).join(" — "), event.link);
    case "actor.move":
      return line(event.actorId, event.roomId ? `went into ${roomName(event.roomId, state)}` : "came back to their desk");
    case "actor.emoji":
      return line(event.actorId, `is feeling ${event.emoji}`);
    case "actor.leave":
      return line(event.actorId, "left");
    case "push":
      return line(event.actorId, `pushed ${event.commits} commit${event.commits === 1 ? "" : "s"} to ${event.branch}`, event.url);
    case "pr.opened":
      return line(event.pr.authorId, `opened PR #${event.pr.number} — ${event.pr.title}`, event.pr.url);
    case "pr.updated":
      return line(event.pr.authorId, `updated PR #${event.pr.number}`, event.pr.url);
    case "pr.review_requested":
      return line(event.reviewerId, `was asked to review PR #${event.number}`);
    case "pr.reviewed":
      return line(event.reviewerId, `${verdict(event.verdict)} PR #${event.number}`);
    case "pr.merged":
      return line(event.actorId, `merged PR #${event.number} 🎉`);
    case "pr.closed":
      return line("", `PR #${event.number} closed`);
    case "issue.opened":
      return line(event.actorId, `opened issue #${event.issue.number} — ${event.issue.title}`, event.issue.url);
    case "issue.assigned":
      return line(event.assigneeId, `was assigned issue #${event.number}`);
    case "issue.commented":
      return line(event.actorId, `commented on #${event.number}`);
    case "issue.closed":
      return line(event.actorId, `closed issue #${event.number}`);
    case "ci.status":
      return line(event.actorId ?? "", `CI on ${event.branch}: ${event.status}`, event.url);
    case "agent.tool_call":
      return line(event.actorId, `${event.call.tool}${event.call.target ? ` ${event.call.target}` : ""}`);
    case "agent.session":
      return line(event.actorId, event.phase === "start" ? "started a session" : "finished a session");
    case "room.created":
      return line("", `room "${event.room.name}" opened`);
    case "room.deleted":
      return line("", `a room closed`);
    case "chat.message":
      return line(event.actorId, `“${event.text}”`);
  }
}

function verdict(v: "approved" | "changes_requested" | "commented"): string {
  return v === "approved" ? "approved" : v === "changes_requested" ? "requested changes on" : "commented on";
}

function roomName(roomId: string, state?: OfficeState): string {
  return state?.rooms.find((r) => r.id === roomId)?.name ?? roomId.split("#")[1] ?? "a room";
}

/** An id as a reader should see it: the actor's name when we know it, else the raw id. */
function displayId(actorId: string, state?: OfficeState): string {
  const known = state?.actors.find((a) => a.actor.id === actorId);
  if (known) return actorDisplayName(known.actor);
  return actorId.startsWith("agent:") ? actorId.split(":").slice(2).join(":") || actorId : actorId;
}
