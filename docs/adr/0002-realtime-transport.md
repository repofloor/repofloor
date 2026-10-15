# ADR 0002 — Realtime transport: WebSocket via `ws`, fan-out over Postgres `LISTEN`/`NOTIFY`

- **Status:** accepted
- **Date:** 2026-10-15
- **Deciders:** @aliosmanmho (sole maintainer)
- **Builds on:** [ADR 0001](0001-full-mode-stack.md), which chose self-hosted TypeScript
  on plain Postgres, deferred Redis, and named `EventPublisher` as the seam this fills

## Context

`apps/api` turns a verified GitHub delivery into `OfficeEvent[]`, reduces it into a
snapshot and publishes an `OfficeUpdate`. Today the default publisher drops it on the
floor. `apps/realtime` is what picks it up and pushes it to every browser watching that
office, which is the whole reason Full mode exists — Lite's freshness floor is the
Actions queue, 30-45 seconds, and nothing about a static page can go below it.

Two questions had to be answered, and they are independent: **what speaks to the
browser**, and **how one process tells another that something happened**.

### Constraints

1. **A socket must not be a cheaper door than a `GET`.** Phase 2A lifted the read check
   into `authorizeOfficeRead(deps, officeId, req)`, taking an `IncomingMessage` — which
   an HTTP upgrade request also is — so that one check could serve both doors.
2. **Rule 1: the engine never knows the data source.** Whatever arrives on the wire has
   to be `OfficeState` and `OfficeEvent` and nothing else, or Lite and Full fork.
3. **Rule 6: no second ACL.** Authorization at connect is a GitHub answer, cached, and
   nothing else.
4. **One maintainer** (ADR 0001). Every moving part has to earn its operational cost.
5. Phase 4 wants room chat and walk-to-talk proximity. Those are genuinely
   client-to-server and chatty, not request/response.

## Decision 1 — WebSocket, using `ws`

**WebSocket**, because of constraint 5. Phase 4 is on the roadmap, not hypothetical.

**Using [`ws`](https://github.com/websockets/ws)**, which becomes the second runtime
dependency after `pg`.

Node has no WebSocket *server*. The `WebSocket` added in Node 22 is the client half of
the browser API; the server side of RFC 6455 is ours to provide or to import.

### Options

| | For | Against |
|---|---|---|
| **`ws`** | No dependencies of its own. The de facto standard, so every bug anyone will hit has been hit already. Masking, fragmentation, ping/pong, close codes and UTF-8 validation are done and tested. | A second runtime dependency, in a service that was proud of having one. |
| **Hand-rolled RFC 6455** | Keeps the count at one. `node:http` already emits `upgrade`. | Masking, continuation frames, ping/pong, the close handshake and UTF-8 validation are ~300 lines of protocol code **on the network edge**, facing unauthenticated bytes. Getting fragmentation or length handling wrong is a denial-of-service hole, not a bug. The test burden for parity is larger than the feature. |
| **SSE + `POST`** | Zero dependencies, pure `node:http`, passes proxies that mangle upgrades, and browsers reconnect by themselves. Would cover 2B completely. | One-directional. Phase 4 would then be a transport migration, with two transports live during it. |

### Why

The dependency is not the expensive thing here — hand-written frame parsing on an
unauthenticated edge is. Writing our own would mean maintaining a security surface in
exchange for a number in `package.json`, while a maintainer with one evening a week is
the actual scarce resource (constraint 4).

SSE was genuinely close, and would have been the answer if 2B were the end of the road.
It is not: picking it would mean building the transport twice and running both at once
during the switch.

`ws` stays behind our own seam, so it is replaceable — the same way `pg` sits behind
`Queryable`.

### Where the connect check actually runs

Constraint 1 says one check, and there were two ways to honour it. The one we took is
not the one 2A anticipated, so it is worth writing down.

**realtime calls `apps/api`'s own `GET /office/:owner/:repo`**, forwarding the client's
`Authorization` header and `Cookie` and nothing else. A `200` admits the socket and its
body is the first snapshot; `401`, `404` and anything else are refusals.

The alternative was for realtime to call `authorizeOfficeRead` itself, against the same
store and the same `GitHubRepoAccess`. That works for a bearer token and *cannot* work
for a browser, which is the case that matters: a WebSocket cannot carry an
`Authorization` header, so a session cookie is a browser's only identity — and sessions
live in the api's memory precisely so that no credential is ever written to the database
(ADR 0001). Resolving a cookie in another process would mean a shared session store with
the GitHub token encrypted at rest, which is the one thing that decision set out to
avoid.

So delegation is not a weaker form of the single check; it is a stronger one. The code
that runs is 2A's, not a copy of it, and realtime ends up holding no credential of its
own — there is nothing in it to compromise into a wider read than the caller already
had. The price is a round trip per connect, and a dependency on the api being
reachable; an unreachable api refuses sockets, because failing open here would be a
hole.

`authorizeOfficeRead` keeps its value either way: it is what made `GET /office/...` a
single auditable check rather than logic tangled into a request handler, and
`app.authorizeRead` is what an in-process deployment would call if one is ever wanted.

## Decision 2 — Fan-out over Postgres `LISTEN`/`NOTIFY`, not Redis

ADR 0001 deferred Redis and said in-process first, then `LISTEN`/`NOTIFY`. This is that
step. `PostgresEventPublisher` sends `NOTIFY`, `PostgresEventSubscriber` holds one
dedicated `LISTEN` connection, and both sit behind the existing `EventPublisher`
interface. No new infrastructure: the database is already there, already backed up,
already in the compose file.

### The 8000-byte problem, and what we do about it

A `NOTIFY` payload is capped at 8000 bytes. An `OfficeState` for a busy repository is
comfortably larger, so the snapshot cannot ride along.

A notification therefore carries a **pointer, and the payload only when it fits**:
`{officeId, events}` when the whole thing is under the limit, `{officeId}` alone when it
is not. The subscriber then either:

- **delivers the events**, and the browser animates each one (`applyEffect`); or
- **loads the current snapshot** from the store and the browser does a full `setState`.

Degrading to a snapshot loses the animation of individual events, not the state. That
is the right thing to lose, and it is a named, bounded failure mode rather than a size
limit discovered in production.

### Consequences

- Any api process now fans out to every realtime process. Concurrent writers to one
  office are what the advisory lock in 2A's `OfficeStore.transaction` made safe.
- A `LISTEN` connection is held open for the life of the process, outside the pool —
  one per realtime process, reconnecting with backoff. On reconnect the subscriber
  cannot know what it missed, so it resyncs by snapshot.
- `NOTIFY` is **not** durable. A delivery that happens while nothing is listening is
  simply not seen. The snapshot in Postgres is still correct, and the next client to
  connect gets it. Realtime is a speed-up over polling, never the source of truth;
  anything that must not be missed is in the database already.
- If presence volume ever outgrows this, Redis slots in behind the same interface. ADR
  0001 said so, and nothing here changes it.

## Decision 3 — Presence is ephemeral, and reuses the events we have

Presence ("who is looking at this office right now") is **not** persisted and is never
written into the snapshot. The snapshot is derived from signed GitHub deliveries;
mixing in who has a browser tab open would make it something else.

It also needs no new protocol. A viewer arriving is `actor.upsert`, a viewer leaving is
`actor.leave`, and a viewer with no other activity lands on `idle`, which the protocol
already defines as "present but no activity". Rule 3 is untouched: `PROTOCOL_VERSION`
does not move.

Two details that are easy to get wrong:

- A viewer's arrival must not *downgrade* them. `actor.upsert` only ensures the actor
  exists and never sets a status, so someone the webhooks show as `coding` keeps
  `coding`.
- On disconnect we emit `actor.leave` **only for viewers who are not in the persisted
  snapshot**. Marking someone offline because they closed a tab, while GitHub says they
  just pushed, would be a lie the floor then renders.

Presence entries carry a TTL refreshed by the socket's own liveness, so a process that
dies does not leave ghosts standing on the floor.

## Consequences

- `apps/realtime` depends on `@repofloor/api` as a workspace package — for the store,
  the subscriber and the logger, not for authorization, which goes over HTTP as above.
  The alternative, a shared `packages/server-core`, is worth extracting the day a third
  service needs these pieces, not before.
- Two reachability requirements rather than one: realtime needs Postgres (to listen,
  and to read snapshots) *and* the api (to authorize). Both failures are refusals, not
  degraded service.
- Second runtime dependency: `ws`. `pg` and `ws`, both behind our own interfaces.
- `docker compose` grows a third service.
- Not a surveillance tool (rule 6, and the project's own line): presence says *who is
  here*, never how long they have been here. There is no session duration to read,
  because none is recorded.
