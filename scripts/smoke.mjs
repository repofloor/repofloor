/**
 * Smoke test for a running Full-mode stack.
 *
 *   webhook → api (verify, reduce, save) → pg_notify → realtime (LISTEN) → ws frame
 *
 *   WEBHOOK_SECRET=dev-secret docker compose up --build -d
 *   WEBHOOK_SECRET=dev-secret node scripts/smoke.mjs
 *
 * The unit tests cover each piece against fakes; this covers the wiring between them,
 * which is exactly what fakes cannot. It is what you run after `docker compose up`, on
 * a new host, or after changing anything about how the services find each other.
 *
 * It writes two offices (`repofloor/repofloor`, `repofloor/secret-lab`) into whatever
 * database the stack points at, so point it at a throwaway one, never production.
 *
 * Needs no dependencies: Node 22 has a global WebSocket client.
 *
 *   API=http://127.0.0.1:8787  WS=ws://127.0.0.1:8788  WEBHOOK_SECRET=dev-secret
 */

import { createHmac } from "node:crypto";

const API = process.env.API ?? "http://127.0.0.1:8787";
const WS = process.env.WS ?? "ws://127.0.0.1:8788";
/**
 * The one origin apps/web is served from. Checked only if it answers, so this script
 * still works against a stack brought up without it.
 */
const PROXY = process.env.PROXY ?? "http://127.0.0.1:8080";
const SECRET = process.env.WEBHOOK_SECRET ?? "dev-secret";
const OFFICE = "repofloor/repofloor";

const sign = (body) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

async function deliver(event, payload, deliveryId) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${API}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": sign(body),
    },
    body,
  });
  return { status: res.status, body: await res.json() };
}

const repository = {
  full_name: OFFICE,
  name: "repofloor",
  default_branch: "main",
  private: false,
  description: "A living pixel office for every GitHub repository",
  owner: { login: "repofloor", type: "Organization", avatar_url: "https://example.test/o.png" },
};

const pushPayload = (n) => ({
  repository,
  ref: "refs/heads/main",
  commits: Array.from({ length: n }, (_, i) => ({ id: `c${i}` })),
  sender: { login: "aliosmanmho", avatar_url: "https://example.test/a.png" },
});

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// 1 ── health
const health = await fetch(`${API}/healthz`).then((r) => r.json());
check("api healthz", health.ok === true, `protocol ${health.protocolVersion}`);

const rtHealth = await fetch(`${WS.replace("ws://", "http://")}/healthz`).then((r) => r.json());
check("realtime healthz", rtHealth.ok === true, `offices ${rtHealth.offices}`);

// 2 ── an unsigned delivery is refused
const unsigned = await fetch(`${API}/webhook`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-github-event": "push", "x-github-delivery": "bad-1" },
  body: JSON.stringify(pushPayload(1)),
});
check("unsigned delivery refused", unsigned.status === 401, `got ${unsigned.status}`);

// 3 ── create the office
const first = await deliver("push", pushPayload(2), `d-${Date.now()}-1`);
check("signed delivery accepted", first.status === 202, `applied ${first.body.applied}`);

// 4 ── it is readable, and public
const office = await fetch(`${API}/office/repofloor/repofloor`);
const state = await office.json();
check("snapshot readable without a token", office.status === 200, `${state.actors?.length} actor(s), mode ${state.mode}`);

// 5 ── the listing shows it
const listing = await fetch(`${API}/offices`).then((r) => r.json());
check(
  "GET /offices lists the public office",
  listing.offices?.some((o) => o.officeId === OFFICE) && listing.partial === false,
  JSON.stringify(listing.offices?.map((o) => o.officeId)),
);

// 6 ── a re-delivery applies nothing
const dupId = `d-${Date.now()}-dup`;
await deliver("push", pushPayload(1), dupId);
const dup = await deliver("push", pushPayload(1), dupId);
check("re-delivery is a no-op", dup.body.applied === 0, `applied ${dup.body.applied}`);

// 7 ── the socket: connect, then make something happen
const frames = [];
const ws = new WebSocket(`${WS}/office/repofloor/repofloor`);

const opened = new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", () => reject(new Error("socket error")), { once: true });
  setTimeout(() => reject(new Error("socket never opened")), 5000);
});
ws.addEventListener("message", (e) => frames.push(JSON.parse(e.data)));

await opened;
await new Promise((r) => setTimeout(r, 300));

check(
  "socket opens and is greeted with hello + snapshot",
  frames[0]?.type === "hello" && frames[1]?.type === "snapshot",
  frames.map((f) => f.type).join(", "),
);

// 8 ── the real thing: a delivery must reach this socket through pg_notify
const before = frames.length;
await deliver("push", pushPayload(3), `d-${Date.now()}-live`);

const arrived = await Promise.race([
  new Promise((resolve) => {
    const check = setInterval(() => {
      if (frames.length > before) {
        clearInterval(check);
        resolve(true);
      }
    }, 50);
  }),
  new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
]);

const live = frames[before];
check(
  "a webhook reaches a live socket through pg_notify",
  arrived && live?.type === "events",
  arrived ? `${live?.type} with ${live?.events?.length ?? 0} event(s)` : "nothing arrived in 5s",
);

// 9 ── a private office must not be readable without a token
const privatePayload = {
  ...pushPayload(1),
  repository: { ...repository, full_name: "repofloor/secret-lab", name: "secret-lab", private: true },
};
await deliver("push", privatePayload, `d-${Date.now()}-priv`);
const refused = await fetch(`${API}/office/repofloor/secret-lab`);
check("private office needs a credential", refused.status === 401, `got ${refused.status}`);

const anonList = await fetch(`${API}/offices`).then((r) => r.json());
check(
  "the listing does not leak the private office",
  !anonList.offices?.some((o) => o.officeId === "repofloor/secret-lab"),
  JSON.stringify(anonList.offices?.map((o) => o.officeId)),
);

// 10 ── a socket to a private office is refused before it becomes a socket
const refusedSocket = await new Promise((resolve) => {
  const s = new WebSocket(`${WS}/office/repofloor/secret-lab`);
  s.addEventListener("open", () => {
    s.close();
    resolve("opened");
  });
  s.addEventListener("error", () => resolve("refused"));
  setTimeout(() => resolve("timeout"), 5000);
});
check("socket to a private office is refused", refusedSocket === "refused", refusedSocket);

ws.close();

// 11 ── the proxied origin, if this stack has one
const proxyUp = await fetch(`${PROXY}/healthz`)
  .then((r) => r.ok)
  .catch(() => false);

if (!proxyUp) {
  console.log(`SKIP  proxied origin — nothing answering on ${PROXY}`);
} else {
  const page = await fetch(`${PROXY}/`);
  check(
    "the page is served from the proxied origin",
    page.status === 200 && (page.headers.get("content-type") ?? "").includes("text/html"),
    `${page.status} ${page.headers.get("content-type")}`,
  );

  // /:owner/:repo is a client-side route, so an unknown path must be index.html.
  const deep = await fetch(`${PROXY}/repofloor/repofloor`);
  check("an app route falls back to index.html", deep.status === 200, `got ${deep.status}`);

  const proxiedSnapshot = await fetch(`${PROXY}/office/repofloor/repofloor`);
  check(
    "a plain GET on /office/... is proxied to the api",
    proxiedSnapshot.status === 200 && (await proxiedSnapshot.json()).office?.id === OFFICE,
    `got ${proxiedSnapshot.status}`,
  );

  // The one this section exists for. The api and realtime both answer on this path;
  // only the Upgrade header tells the proxy which one the caller means.
  const proxiedFrames = [];
  const proxiedWs = new WebSocket(`${PROXY.replace(/^http/, "ws")}/office/repofloor/repofloor`);
  proxiedWs.addEventListener("message", (e) => proxiedFrames.push(JSON.parse(e.data)));

  const upgraded = await new Promise((resolve) => {
    proxiedWs.addEventListener("open", () => resolve(true), { once: true });
    proxiedWs.addEventListener("error", () => resolve(false), { once: true });
    setTimeout(() => resolve(false), 5000);
  });
  await new Promise((r) => setTimeout(r, 300));

  check(
    "an upgrade on the SAME path is routed to realtime",
    upgraded && proxiedFrames[0]?.type === "hello" && proxiedFrames[1]?.type === "snapshot",
    upgraded ? proxiedFrames.map((f) => f.type).join(", ") : "the upgrade never completed",
  );

  // And it is a live socket, not just a handshake.
  const beforeProxied = proxiedFrames.length;
  await deliver("push", pushPayload(1), `d-${Date.now()}-proxied`);
  const reached = await Promise.race([
    new Promise((resolve) => {
      const poll = setInterval(() => {
        if (proxiedFrames.length > beforeProxied) {
          clearInterval(poll);
          resolve(true);
        }
      }, 50);
    }),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  check(
    "a webhook reaches a socket through the proxy",
    reached && proxiedFrames[beforeProxied]?.type === "events",
    reached ? proxiedFrames[beforeProxied]?.type : "nothing arrived in 5s",
  );

  proxiedWs.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
