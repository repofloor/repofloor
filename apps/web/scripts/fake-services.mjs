/**
 * The api and the socket, faked, for working on this app alone.
 *
 *   node scripts/fake-services.mjs      # api on :8787, socket on :8788
 *
 * Why it exists: Full mode's real services need Postgres, a GitHub App and a public
 * tunnel, and none of that is needed to lay out a page. This answers the four routes
 * `apps/web` calls and speaks the frames `apps/realtime` speaks, with a seeded office
 * and a trickle of events — so the office page, the strip, the activity log and the
 * live indicator can all be seen working.
 *
 * It is a fixture, not a second implementation: the snapshot is built by the real
 * reducer out of real events, and the frames are the ones in `apps/realtime/src/wire.ts`.
 * It authorizes nothing, so never run it anywhere but a laptop.
 */

import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { emptyOfficeState } from "@repofloor/protocol";
import { reduce } from "@repofloor/reducer";

const API_PORT = Number(process.env.PORT ?? 8787);
const WS_PORT = Number(process.env.WS_PORT ?? 8788);
const OFFICE_ID = process.env.OFFICE_ID ?? "repofloor/repofloor";
const [OWNER, REPO] = OFFICE_ID.split("/");

const PEOPLE = [
  { id: "aliosmanmho", name: "Ali Osman", emoji: "🛠" },
  { id: "mehmet-k", name: "Mehmet K" },
  { id: "zeynep", name: "Zeynep", emoji: "☕" },
  { id: "deniz", name: "Deniz" },
];
const AGENT = "agent:aliosmanmho:claude";

let seq = 0;
const at = () => new Date().toISOString();
const ev = (rest) => ({ id: `fake-${++seq}`, at: at(), officeId: OFFICE_ID, ...rest });

function seed() {
  let state = emptyOfficeState(
    { id: OWNER, name: OWNER, kind: "organization" },
    { id: OFFICE_ID, buildingId: OWNER, name: REPO, description: "A living pixel office for every GitHub repository.", private: false, defaultBranch: "main" },
    "full",
  );
  const events = [
    ...PEOPLE.map((p) => ev({ type: "actor.upsert", actor: { id: p.id, kind: "human", name: p.name, ...(p.emoji ? { emoji: p.emoji } : {}) } })),
    ev({ type: "actor.upsert", actor: { id: AGENT, kind: "agent", name: "claude", agent: { provider: "claude-code", ownerId: "aliosmanmho" } } }),
    ev({ type: "room.created", room: { id: `${OFFICE_ID}#standup`, officeId: OFFICE_ID, kind: "team", name: "Standup" } }),
    ev({ type: "room.created", room: { id: `${OFFICE_ID}#focus`, officeId: OFFICE_ID, kind: "focus", name: "Focus" } }),
    ev({ type: "push", actorId: "aliosmanmho", branch: "feat/web", commits: 3, url: `https://github.com/${OFFICE_ID}` }),
    ev({
      type: "pr.opened",
      pr: { number: 25, title: "apps/web: the hosted office", authorId: "aliosmanmho", url: `https://github.com/${OFFICE_ID}/pull/25`, draft: false, reviewerIds: ["mehmet-k"], updatedAt: at() },
    }),
    ev({ type: "pr.review_requested", number: 25, reviewerId: "mehmet-k" }),
    ev({ type: "issue.commented", number: 15, actorId: "zeynep" }),
    ev({ type: "ci.status", status: "running", branch: "feat/web", actorId: "aliosmanmho", prNumber: 25 }),
    ev({ type: "agent.tool_call", actorId: AGENT, call: { at: at(), tool: "Edit", target: "apps/web/src/views/office.ts" } }),
    ev({ type: "actor.move", actorId: "deniz", roomId: `${OFFICE_ID}#focus` }),
  ];
  for (const event of events) state = reduce(state, event);
  return state;
}

let state = seed();

/** Something plausible every couple of seconds, so the page is visibly alive. */
function nextEvent() {
  const pick = Math.floor(Math.random() * 7);
  switch (pick) {
    case 0:
      return ev({ type: "agent.tool_call", actorId: AGENT, call: { at: at(), tool: ["Read", "Edit", "Bash", "Grep"][Math.floor(Math.random() * 4)], target: "apps/web/src/live.ts" } });
    case 1:
      return ev({ type: "push", actorId: "mehmet-k", branch: "main", commits: 1 + Math.floor(Math.random() * 2) });
    case 2:
      return ev({ type: "pr.reviewed", number: 25, reviewerId: "mehmet-k", verdict: "approved" });
    case 3:
      return ev({ type: "ci.status", status: "success", branch: "feat/web", actorId: "aliosmanmho" });
    case 4:
      return ev({ type: "actor.move", actorId: "zeynep", roomId: `${OFFICE_ID}#standup` });
    case 5:
      return ev({ type: "issue.commented", number: 16, actorId: "deniz" });
    default:
      return ev({ type: "pr.merged", number: 25, actorId: "aliosmanmho" });
  }
}

// ── the api ───────────────────────────────────────────────────────────────────

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

let signedIn = process.env.ANONYMOUS !== "1";

const api = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/auth/me") {
    return signedIn
      ? json(res, 200, { login: "aliosmanmho", id: 1, avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4", expiresAt: new Date(Date.now() + 36e5).toISOString() })
      : json(res, 401, { error: "unauthenticated" });
  }
  if (path === "/auth/logout") {
    signedIn = false;
    return json(res, 200, { ok: true });
  }
  if (path === "/offices") {
    return json(res, 200, {
      offices: [
        { officeId: OFFICE_ID, name: REPO, buildingId: OWNER, private: false, generatedAt: state.generatedAt, actors: state.actors.length },
        { officeId: `${OWNER}/lite-demo`, name: "lite-demo", buildingId: OWNER, private: true, generatedAt: state.generatedAt, actors: 2 },
        { officeId: "aliosmanmho/dotfiles", name: "dotfiles", buildingId: "aliosmanmho", private: true, generatedAt: state.generatedAt, actors: 1 },
      ],
      partial: process.env.PARTIAL === "1",
    });
  }
  if (path === `/office/${OFFICE_ID}`) return json(res, 200, state);
  if (path.startsWith("/office/")) return json(res, 404, { error: "unknown_office" });
  return json(res, 404, { error: "not_found" });
});

api.listen(API_PORT, () => console.log(`fake api      http://localhost:${API_PORT}`));

// ── the socket ────────────────────────────────────────────────────────────────

const ws = createServer((req, res) => json(res, 426, { error: "upgrade_required" }));
const wss = new WebSocketServer({ server: ws, path: `/office/${OFFICE_ID}` });

wss.on("connection", (socket) => {
  const send = (message) => socket.readyState === 1 && socket.send(JSON.stringify(message));
  send({ type: "hello", officeId: OFFICE_ID, protocolVersion: state.protocolVersion, viewer: signedIn ? { login: "aliosmanmho" } : undefined });
  send({ type: "snapshot", officeId: OFFICE_ID, state });

  const timer = setInterval(() => {
    const event = nextEvent();
    state = reduce(state, event);
    send({ type: "events", officeId: OFFICE_ID, events: [event] });
  }, Number(process.env.TICK_MS ?? 2500));

  socket.on("close", () => clearInterval(timer));
});

ws.listen(WS_PORT, () => console.log(`fake realtime ws://localhost:${WS_PORT}/office/${OFFICE_ID}`));
