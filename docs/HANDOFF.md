# Handoff — where the project stands

_Last updated: 2026-10-15 (Phase 2A, 2B and 2C done: api hardening, `apps/realtime`, then `apps/web` — the hosted UI, live on the socket)._

## Done (Phase 0)

- Protocol v1.0.0, reducer with 8 tests, GitHub webhook mapper (push, pull_request, review, issues, comments, workflow_run, check_suite).
- Pixi engine: desks, team/meeting/focus rooms with seat assignment, procedural human + robot avatars,
  status icons/animations (coding, reviewing, discussing, building, blocked, celebrating, in_room, focus, offline),
  agent tool-trail bubble, CI lamp, wall board, confetti on merge, hover tooltip, click → link.
- Demo with simulator + manual event buttons. Verified in headless Chromium (screenshot in `docs/assets/office.png`).
- Lite action: `collect.ts` (REST → events → replay with decay), bundled with esbuild, `action.yml`, Pages workflow dogfooding this repo.
- Docs + templates for an open-source community.
- Published: repo lives at <https://github.com/repofloor/repofloor>, Pages is on (Source: GitHub Actions) and the
  dogfooded office is live at <https://repofloor.github.io/repofloor/>. The `CI` and `Repofloor office` workflows are green.
- The 16 starter issues from `docs/GOOD_FIRST_ISSUES.md` are open as issues #1-#16, labelled `good first issue`
  plus an area label (`engine`, `reducer`, `lite`, `demo`).

## Done (Phase 2 kick-off)

- `docs/adr/0001-full-mode-stack.md`: **self-hosted TypeScript services on plain Postgres**, Supabase not adopted
  as the platform. Redis deferred (in-process fan-out, then Postgres `LISTEN`/`NOTIFY`); the database stays
  replaceable; authorization is a cached GitHub call, never a permissions table.
- `apps/api` skeleton, no runtime dependencies beyond the two workspace packages: HMAC-SHA256 signature
  verification over the raw body (`WEBHOOK_SECRET`), `githubToEvents` + `reduce` into an office snapshot,
  dedup on delivery-derived event ids, `POST /webhook`, `GET /office/:owner/:repo` (with decay on read),
  `GET /healthz`. `apps/api/README.md` has the GitHub App setup and local tunnel instructions.
- **Postgres behind `OfficeStore`** (next step 2a, done): `PostgresOfficeStore` on plain SQL — `offices`
  (snapshot as `jsonb`) and `applied_events` (primary key on the event id, so dedup survives a restart),
  numbered `.sql` migrations applied at startup by a small runner, an hourly retention cut on old event ids.
  `pg` is the only new dependency and is imported lazily; without `DATABASE_URL` the in-memory store is used
  and `pg` is never loaded. The `OfficeStore` interface is unchanged.
- **Authorized reads** (next step 2b, done): `GET /office/:owner/:repo` asks GitHub
  `GET /repos/{owner}/{repo}` with the caller's own `Authorization: Bearer <token>`, caches the answer per
  (caller, repo) for 60s and drops it on `installation_repositories` / `member` deliveries. No permissions
  table — GitHub stays the only ACL. Public offices need no token; unknown visibility is treated as private.
  A refused caller gets the same `404` as a non-existent office.
- **Sign-in and App installation** (next step 2c, done): "Sign in with GitHub" through the App's OAuth leg —
  `/auth/github` → `/auth/github/callback` → a server-side session behind a signed, `HttpOnly` cookie that
  holds an opaque id and nothing else, so the browser never sees the GitHub token. `GET /office/...` accepts
  that session *or* the bearer token it accepted before, and both still end in the same `RepoAccess.canRead`:
  a session is an identity, not a permission, and there is still no permissions table (rule 6 intact).
  `/auth/me`, `POST /auth/logout` (destroys the record server-side), `/auth/install`, and the App's Setup URL
  `/auth/install/callback`, which reads the installation back from GitHub as the App rather than trusting the
  unsigned `installation_id`. Installations are persisted by migration `002_installations.sql` and by the
  signed `installation` delivery; installation tokens are minted from the private key (RS256 JWT via
  `node:crypto`) and cached **in memory**, so the database holds no credential at all. Still no new runtime
  dependency — `pg` remains the only one.
- `docker-compose.yml` + Dockerfiles: `WEBHOOK_SECRET=dev-secret docker compose up --build` brings up
  Postgres + api + realtime. **Run for real on 2026-10-15** (2D-1) — see below.
- 91 tests in `apps/api` (one skipped: the Postgres integration test runs only with `DATABASE_URL` set).
  No live GitHub and no live database in CI: GitHub is faked, and the App JWT is verified against a keypair
  generated inside the test.

## Done (Phase 2A — `apps/api` hardening)

- **A1**: the read decision moved out of `handleOffice` into `src/authorize.ts`
  (`authorizeOfficeRead`, exposed as `app.authorizeRead`). It takes an `IncomingMessage`, which a
  WebSocket upgrade request also is, so 2B's socket runs this check rather than its own.
- **A2**: ingest is atomic. `OfficeStore.transaction(key, fn)` — optional, so a store without one
  runs inline — wraps mark-delivered + save, and publishing moved after the commit. The Postgres
  implementation takes a transaction-scoped `pg_advisory_xact_lock` on the office id, which extends
  the in-process `KeyedQueue` guarantee across processes and covers an office's first delivery too.
- **A3**: `GET /offices` (public to anyone, private only to a caller GitHub vouches for, `partial`
  when a check was unavailable); structured JSON logs in `src/log.ts` with `LOG_LEVEL`, wired through
  `createApp` and `server.ts` — query strings are never logged, because the OAuth callback carries a
  live code in one; and [`docs/OPERATIONS.md`](OPERATIONS.md) with the single-command `pg_restore`
  ADR 0001 promised, plus what every log line means.
- 122 tests in `apps/api` (one skipped: the Postgres integration test needs `DATABASE_URL`).

## Done (Phase 2B — `apps/realtime`)

- [ADR 0002](adr/0002-realtime-transport.md): **WebSocket via `ws`** (Node has no WebSocket *server*; writing
  RFC 6455 ourselves would mean maintaining frame parsing on an unauthenticated edge), **fan-out over Postgres
  `LISTEN`/`NOTIFY`** rather than Redis, and **ephemeral presence** that needs no protocol change.
- **B1**: `PostgresEventPublisher` / `PostgresEventSubscriber` in `apps/api`. A `NOTIFY` payload is capped at
  8000 bytes, so a notification carries its events when they fit and a bare office id when they do not; the
  subscriber then loads the snapshot. One dedicated `LISTEN` connection outside the pool, reconnecting with
  backoff, and reporting a resync afterwards because it cannot know what it missed.
- **B2**: `apps/realtime` — `ws` behind `src/socket.ts`, one channel per office, created on the first join and
  dropped on the last leave. **Every socket is authorized by asking `apps/api`'s own `GET /office/...` with the
  caller's credentials forwarded**, so the check that runs is A1's rather than a copy: a WebSocket cannot carry
  an `Authorization` header, so a browser's only identity is the session cookie, and sessions stay in the api's
  memory so no credential is ever written to the database. realtime holds no credential of its own. A refused
  client never becomes a socket — the upgrade gets 401/404/503 and the connection is destroyed.
- **B3**: presence with TTL. Arrival is `actor.upsert`, departure `actor.leave`, a watcher lands on `idle` —
  no protocol change, `PROTOCOL_VERSION` unmoved. Two tabs are one person; a departure is announced only for a
  viewer the persisted snapshot does not already know, so closing a tab never marks a contributor offline.
  Liveness comes from the socket's own ping/pong, not from user activity.
- `docker-compose.yml` grows a `realtime` service; `apps/realtime/Dockerfile` mirrors the api's.
- 41 tests in `apps/realtime` (hub and presence with no network; the socket tests run real `ws` against a real
  `node:http` server), 132 in `apps/api`. Second runtime dependency: `ws`, after `pg`.
- One bug the tests caught: `/office/a%2Fb/c` decoded into the three-segment id `a/b/c`, which would have
  authorized one office and joined a channel named another. Segments are now validated after decoding.

## Done (Phase 2C — `apps/web`)

- The hosted UI, **Vite + TypeScript, no framework**: four pages (`/`, `/:owner`, `/:owner/:repo`,
  `/installed`), history routing, and a `<main>` the router swaps. ARCHITECTURE calls this app thin and
  it is: the pages are DOM, the behaviour is in the packages.
- **C1** The office page mounts `@repofloor/engine` against `GET /office/:owner/:repo`, in the shape
  `apps/demo` already used — `setState` for state, `applyEffect` for events, local `decay` between
  arrivals. Rule 1 holds: nothing but `OfficeState` and `OfficeEvent` reaches the renderer, which is
  why the same renderer still draws the Lite page from a static file.
- **C2** Sign-in behind a button (`/auth/github?return_to=…`), `/auth/me` at boot deciding the header
  and the empty states, `POST /auth/logout`, and `/installed` — a real page for what
  `/auth/install/callback` answers as JSON. Point the App's Setup URL at
  `/auth/install/callback?return_to=/installed`.
- **C3** Buildings → offices → office, all three from one `GET /offices`. `partial: true` renders as a
  notice saying the list is short and why, rather than looking complete.
- **C4** The 2B socket: `hello` is what turns the indicator live (not the open event), `snapshot`
  replaces state wholesale, `events` animate and are reduced locally with the same pure `reduce` the
  server ran — otherwise the strip and the log would drift from the canvas. Reconnect is exponential
  with ±25% jitter (every page watching an office loses its socket in the same instant); `4001`/`4004`/
  `4003` end the loop, because retrying a refusal only makes the api authorize us again.
- **Two items of `docs/VISUAL_TARGET.md` fell out**, both DOM rather than engine work: the per-actor
  status strip (`name · emoji · what they are doing`, busiest first) and the running activity log. Together
  they are most of issue #15 — the office in words, in the DOM rather than inside a WebGL context.
  `src/describe.ts` is pure and has no DOM import, so `apps/demo` can lift it as it is.
- **No second ACL anywhere in it** (rule 6): a `401` offers sign-in, a `404` says "does not exist, or is
  not yours" without claiming which, and `GET /offices` is taken at its word. The page holds no
  credential; the token stays in the api's memory.
- **One origin.** The api, the socket and these files are behind one reverse proxy, which routes
  `/office/...` by the `Upgrade` header. Not a preference: the session cookie is `HttpOnly`,
  `SameSite=Lax`, so a cross-site `fetch` would not carry it and the page would be permanently signed
  out. `apps/web/README.md` has the proxy table.
- `scripts/fake-services.mjs` (`pnpm --filter @repofloor/web dev:fake`) answers the four routes and
  speaks the wire format with a seeded office and a trickle of events, so the page can be worked on
  without Postgres, a GitHub App or a tunnel. A fixture, not a second implementation — the snapshot is
  built by the real reducer out of real events. It authorizes nothing.
- 45 tests in `apps/web`, all DOM-free: routing, url building, frame parsing (including a snapshot from
  a future protocol major, which is refused rather than rendered), the strip and log wording over every
  event variant, the api's failure mapping, and the socket's state machine against a fake socket.
- Verified in the browser against the fixture at 360px and at 1024px: the floor renders, events arrive
  live, the strip reorders, the log fills, and the 404 page is the error state rather than an empty canvas.
  One real bug came out of looking: a flex-grown canvas box feeds back into Pixi's `resizeTo` and the
  floor grew to 6500px. The canvas height is `vh`-based and definite at every width now.
## Done (Phase 2D-1 — the stack, actually running)

- `docker compose up --build` brought up Postgres + api + realtime on 2026-10-15. Two things it revealed
  that no amount of reading would have:
  - **There was no `.dockerignore`.** Every Dockerfile installs from the lockfile and then copies sources,
    so that copy dropped the host’s `node_modules` on top of the one just installed. On Windows those are
    junctions into the host pnpm store, so the build died with `Cannot find module .../typescript/bin/tsc`.
    On Linux it would have *succeeded*, silently, with whatever the developer happened to have — the worse
    failure. Added, and it also cuts the build context down to almost nothing.
  - Publishing Postgres on 5432 collides with a local one. `POSTGRES_PORT` already existed for this;
    documented rather than changed, since nothing inside the stack uses the published port.
- **`pnpm smoke`** ([`scripts/smoke.mjs`](../scripts/smoke.mjs)): 12 checks against a running stack, all
  passing. The one that matters is *a webhook reaching a live WebSocket through `pg_notify`* — the first
  time that chain has run outside a test double. It also pins the authorization properties against the real
  thing: unsigned deliveries refused, a private office refused on both doors, and its name absent from
  `GET /offices`.
- **The documented restore was run** and does what `docs/OPERATIONS.md` claims: a single `pg_restore`
  brought back a deliberately deleted office. The api can stay up through it (the drop/recreate is one
  transaction, pooled connections survive), and `LISTEN` survives too — the channel belongs to the session,
  not the schema.

## Done (Phase 2D-1b — the stack serves a page)

- `apps/web` is in `docker-compose.yml`. One `web` service, built in two stages: Vite builds the bundle,
  and Caddy serves it **and** reverse-proxies `api` and `realtime` onto one origin. One service rather
  than a static server plus a separate proxy — a bundle and the routing in front of it change together,
  and ADR 0001's constraint is one maintainer.
- `WEBHOOK_SECRET=dev-secret docker compose up --build` now really is Full mode in one command:
  **<http://localhost:8080>**. Verified in a browser — the floor renders, and three webhooks delivered to
  the api moved it live with no reload (screenshot: `docs/assets/full-mode-proxied.jpg`).
- **The casing bug worth remembering.** Caddy matches header *values* case-sensitively; RFC 9110 makes
  them case-insensitive. The documented `@websocket` recipe (`header Connection *Upgrade*`) therefore
  matches a hand-typed `curl` and misses every real client, which send `connection: upgrade` lower case.
  The matcher is `*pgrade*`. When it is wrong the upgrade lands on `api`, which answers an ordinary
  `404`, and the page shows a floor that never moves — no error anywhere. `pnpm smoke` now has a check
  for exactly this, and it is why the smoke test earned its place twice.
- `pnpm smoke` is 17 checks now; the last four go through the proxied origin, including that an upgrade
  and a plain `GET` on the *same* path reach different services. They skip rather than fail when no
  proxy answers, so a services-only stack still passes.
- `WEB_PORT` joins `POSTGRES_PORT`, `API_PORT` and `REALTIME_PORT`: 8080 is taken on a developer
  machine about as often as 5432 is.

## Noted, not scheduled

- **Visual target** ([`docs/VISUAL_TARGET.md`](VISUAL_TARGET.md), 2026-10-15): a pixel-art reference from the
  maintainer. Rooms as real architecture rather than tinted regions, furniture that differs by room kind, a
  per-actor status strip and a running activity log under the canvas. Broken into a Phase 1.5 in the roadmap.
  Phase 2 stays ahead of it. The last two items landed in `apps/web` with 2C; the engine-side ones (walls,
  doorways, furniture by room kind, the palette pass) are untouched and are the larger half.

## Not yet done / known rough edges

- Speech bubbles overlap when several actors in the top desk row talk at once (needs simple collision/stagger).
- Avatars walk in straight lines through desks (A* on the tile grid — issue #5).
- `applyEffect` is called by the demo; Lite page never calls it (no live events) — fine for now.
- No engine unit tests (visual package). A Playwright screenshot workflow is issue #16.
- Lite `collect.ts` does not page beyond 100 commits / 50 PRs / 50 issues / 20 runs.
- `apps/realtime`: the resync after a reconnect reloads every live office at once. Fine at this scale, a
  thundering herd at a thousand.
- `apps/api`: sessions live in memory, so a restart signs everyone out and more than one instance needs
  sticky sessions. Deliberate — it keeps every credential out of the database — but it is the first thing to
  revisit when the service is run in more than one place.
- `apps/api`: the sign-in flow has never been run against the real github.com. Everything is covered against
  a faked GitHub; creating the App and walking the redirect once is still owed.
- `monitors` map redraw happens per `setState` for every actor — cheap, but could be diffed.
- `apps/web`: never run against the real `apps/api` or `apps/realtime` — only against its own fixture.
  It is written to the routes and the wire format as they are in this repo, but 2D-1 is where that is proven.
- `apps/web`: `src/wire.ts` is a hand-kept copy of the client half of `apps/realtime/src/wire.ts`, because a
  browser bundle must not depend on a server package. Every frame is validated, so drift degrades to "frame
  ignored" rather than a broken page — but it is drift that nothing checks.
- `apps/web`: no light theme, deliberately (the engine's floor is dark and opaque), and no localization yet
  (Phase 1 lists tr/en). The strip and the log are English strings in `src/describe.ts`.
- `apps/web`: the office page polls nothing. If the socket is refused, the snapshot is whatever the first
  `GET` returned and it ages in place — correct, but a Lite-style poll would be a cheap fallback.
- `apps/demo` still has no status strip and no activity log; `src/describe.ts` is pure and could be lifted.

## Immediate next steps (suggested order)

The remaining Full-mode work is phased in [`docs/ROADMAP.md`](ROADMAP.md) as **2A → 2B → 2C → 2D**,
and each sub-phase there is lettered (A1, A2, …). This list says only where we are in it:

1. ~~**2A — `apps/api` hardening**~~, done. A1 lifts the read check out of `handleOffice`
   (2B's socket needs the identical check), A2 makes ingest atomic, A3 clears the operational
   leftovers. Nothing in 2B/2C should start before A1.
2. ~~**2B — `apps/realtime`**, then **2C — `apps/web`**~~ — both done. Next is **2D — run it against
   the real GitHub and a real Docker host**, and D1 now has a web service to add to
   `docker-compose.yml` beside api and realtime. D2 matters more than it looks: no part of the
   sign-in flow has ever met github.com, and `apps/web` has only ever met its own fixture.
3. Phase 1 polish (bubble stagger, A* walking #5, night tint #4, text alternative #15) is
   deliberately *not* in this queue — those are the `good first issue` set, left for contributors.
   Take one only if it ages without a taker.

## Decisions already made

- Name: **repofloor** (GitHub org, .com/.dev, npm scope all free as of 2026-10-15).
- License: MIT.
- Lite = GitHub Action + Pages, no server, no secrets beyond `GITHUB_TOKEN`.
- Full = GitHub App (not OAuth App); authorization mirrors GitHub repo access.
- Agents are first-class actors (`kind: "agent"`, id `agent:<owner>:<name>`), fed by editor/CLI hooks (Claude Code `PostToolUse` first).
- Backend language is free; the only shared contract is `@repofloor/protocol` (JSON).
