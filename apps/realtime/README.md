# apps/realtime

Part of **Full mode**. One WebSocket channel per office, fed by Postgres
`LISTEN`/`NOTIFY`. Design and the reasoning behind it:
[ADR 0002](../../docs/adr/0002-realtime-transport.md).

Lite mode needs none of this — it re-reads a static `office-state.json` every 15
seconds. This is what goes below that floor.

```
GitHub ──▶ apps/api ──┬──▶ Postgres (snapshot)
                      └──▶ pg_notify ──▶ apps/realtime ──▶ ws ──▶ browser
```

## The socket

```
ws://realtime/office/:owner/:repo
```

Server → client:

| Frame | Meaning |
|---|---|
| `{type:"hello", officeId, protocolVersion, viewer?}` | First frame. `viewer` is present only for a signed-in browser. |
| `{type:"snapshot", officeId, state}` | Replace local state (`OfficeRenderer.setState`). Sent at connect, after a gap, and when an update was too large to send as events. |
| `{type:"events", officeId, events}` | Apply in order (`applyEffect`). The animated path. |
| `{type:"pong", at}` | Answer to a client `ping`. |

Client → server: `{type:"ping"}`, and nothing else. Anything unrecognized is dropped
rather than answered.

Only `OfficeState` and `OfficeEvent` cross the wire — rule 1. A client that handled
`snapshot` alone would be correct, just less alive.

## Authorization

**Every socket is authorized by asking `apps/api`**, forwarding the client's own
`Authorization` header and `Cookie` and nothing else. The `200` from
`GET /office/:owner/:repo` is both the answer and the first snapshot, so one round trip
does both.

This is not indirection for its own sake. It is the strongest available form of rule 6:

- The check that runs is literally phase 2A's `authorizeOfficeRead`, not a copy that
  can drift from it.
- A browser cannot set an `Authorization` header on a WebSocket, so a session cookie is
  its only identity. Sessions live in the api's memory on purpose — no credential is
  ever written to the database (ADR 0001) — so realtime *cannot* resolve a cookie
  itself, and forwarding keeps the token inside the process that owns it.
- This service holds no credential of its own. There is nothing here to compromise into
  a wider read than the caller already had.

A refused client never becomes a socket: the upgrade is answered with `401`, `404` or
`503` and the connection is destroyed. Admitting first and closing after would leave a
window in which an unauthorized socket exists.

If the api cannot be reached, sockets are refused. Failing open would be a hole.

## Presence

Who is looking at an office right now. Three properties, all enforced in
[`src/presence.ts`](src/presence.ts) rather than remembered:

- **Never persisted.** It lives in this process and dies with it.
- **No new protocol.** Arrival is `actor.upsert`, departure is `actor.leave`, and a
  viewer with no other activity lands on `idle` — "present but no activity", which the
  protocol already defines. `PROTOCOL_VERSION` does not move.
- **Not a surveillance tool.** An entry records that someone is here and when we last
  heard from their socket. There is no arrival time and no duration, because nothing
  should be able to read one.

Two tabs are one person. A departure is announced only for a viewer the *persisted*
snapshot does not already know — telling the floor that someone went offline because
they closed a tab, while GitHub says they just pushed, would be a lie the renderer then
draws.

Liveness comes from the socket's own ping/pong, not from user activity: being quiet is
not being away. A socket that stops answering is terminated and its viewer leaves the
floor after `PRESENCE_TTL_MS`.

## Fan-out, and what it does not guarantee

`apps/api` sends `pg_notify`; this service holds one dedicated `LISTEN` connection,
outside the pool, reconnecting with backoff.

A `NOTIFY` payload is capped at 8000 bytes, so a notification carries its events only
when they fit and a bare office id when they do not. On a pointer — or after a
reconnect, when nothing can know what was missed — the snapshot is loaded from Postgres
and sent whole. Degrading loses the animation of individual events, not the state.

`NOTIFY` is **not durable**. A delivery that happens while nothing is listening is not
seen. That is deliberate: the snapshot in the database is still correct, and realtime
is a speed-up over polling, never the source of truth.

## Run it

```bash
DATABASE_URL=postgres://repofloor:repofloor@localhost:5432/repofloor \
API_URL=http://localhost:8787 \
pnpm --filter @repofloor/realtime dev
```

Or with the rest of Full mode:

```bash
WEBHOOK_SECRET=dev-secret docker compose up --build
```

| Variable | |
|---|---|
| `DATABASE_URL` | **required** — the same Postgres `apps/api` writes to |
| `API_URL` | **required** — where `apps/api` listens, e.g. `http://api:8787` |
| `PORT` | default `8788` |
| `HOST` | default `0.0.0.0` |
| `DATABASE_SSL` | `require` \| `no-verify` \| `disable` |
| `HEARTBEAT_MS` | how often sockets are pinged (default `30000`) |
| `PRESENCE_TTL_MS` | how long a silent viewer stays on the floor (default `90000`) |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` \| `silent` (default `info`) |

`GET /healthz` answers `{ok, offices}`. Any other plain-HTTP request gets `426`.

## Test

```bash
pnpm --filter @repofloor/realtime test
```

No database and no network: the hub's `Client` is "something you can send a string
to", the authorizer is an interface, and the socket tests run a real `ws` connection
against a real `node:http` server on an ephemeral port.

`pnpm build` must have run at least once, because this package imports
`@repofloor/api` through its built `dist`.

## Design notes

- `ws` is wrapped by [`src/socket.ts`](src/socket.ts) and nothing below it knows the
  library exists — the same way `pg` sits behind `Queryable`. ADR 0002 has the full
  argument for importing rather than hand-writing RFC 6455.
- The hub holds no channel for an office nobody is watching: channels are created on
  the first join and dropped on the last leave, so an idle deployment holds nothing.
- One broken socket cannot stop the rest of the floor updating; a failed `send` is
  logged at debug and the broadcast continues.
- This service depends on `@repofloor/api` as a workspace package, deliberately. A
  shared `packages/server-core` is worth extracting the day a third service needs
  these pieces, not before.
