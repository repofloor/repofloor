# Handoff — where the project stands

_Last updated: 2026-10-15 (Phase 2: ADR 0001, apps/api skeleton, Postgres store, authorized reads, sign-in + App installation)._

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
- `docker-compose.yml` + `apps/api/Dockerfile`: `WEBHOOK_SECRET=dev-secret docker compose up --build` brings up
  api + Postgres. Written but not run — no Docker daemon on the machine that wrote it.
- 91 tests in `apps/api` (one skipped: the Postgres integration test runs only with `DATABASE_URL` set).
  No live GitHub and no live database in CI: GitHub is faked, and the App JWT is verified against a keypair
  generated inside the test.

## Not yet done / known rough edges

- Speech bubbles overlap when several actors in the top desk row talk at once (needs simple collision/stagger).
- Avatars walk in straight lines through desks (A* on the tile grid — issue #5).
- `applyEffect` is called by the demo; Lite page never calls it (no live events) — fine for now.
- No engine unit tests (visual package). A Playwright screenshot workflow is issue #16.
- Lite `collect.ts` does not page beyond 100 commits / 50 PRs / 50 issues / 20 runs.
- `apps/api`: `markDelivered` then `save` are two statements. A crash in between loses that one event's
  effect. Needs a transaction across the ingest loop (an `OfficeStore` change) or the planned periodic resync.
- `apps/api`: `store.list()` has no HTTP route yet, and the read check lives inside `handleOffice` — lift it
  out when `apps/realtime` needs the same check at socket connect.
- `apps/api`: sessions live in memory, so a restart signs everyone out and more than one instance needs
  sticky sessions. Deliberate — it keeps every credential out of the database — but it is the first thing to
  revisit when the service is run in more than one place.
- `apps/api`: the sign-in flow has never been run against the real github.com. Everything is covered against
  a faked GitHub; creating the App and walking the redirect once is still owed.
- `monitors` map redraw happens per `setState` for every actor — cheap, but could be diffed.

## Immediate next steps (suggested order)

1. Phase 1 quick wins: bubble stagger, A* walking (#5), night tint (#4), text alternative under the canvas (#15).
2. Phase 2, next slices of `apps/api` (the ADR, the skeleton, the Postgres store, authorized reads and
   sign-in + installations are done):
   a. **`apps/realtime`**: WebSocket fan-out per office consuming `EventPublisher` (Postgres `LISTEN`/`NOTIFY`
      first), presence with TTL. The same read check must gate a socket at connect time, so lift it out of
      `handleOffice` when it is needed in two places — and a socket should be able to authenticate with the
      session cookie, which now exists.
   b. **`apps/web`**: the first consumer of sign-in. A page that mounts the engine against
      `GET /office/:owner/:repo`, with `/auth/github` behind a button and `/auth/me` deciding what to show.
      It is also what turns `/auth/install/callback`'s JSON into a real landing page (pass `return_to`).
   c. **Sessions across restarts and instances**, if and when it hurts: a `SessionStore` on Postgres with the
      user token encrypted at rest, or refresh tokens so a session holds a short-lived credential. Today a
      restart signs people out and two instances need sticky sessions.
   d. **Use the App identity for something**: a periodic resync that mints an installation token and rebuilds
      an office from the REST API (the same `collect.ts` shape Lite uses), which also closes the
      `markDelivered`/`save` gap below.
   e. Run `docker compose up --build` once on a machine with Docker and fix whatever the build reveals; add
      `realtime` to the compose file when it exists.
   f. Operational leftovers: a `GET /offices` listing (the store's `list` has no route), structured logs,
      and a documented single-command Postgres restore (ADR 0001 promises one).

## Decisions already made

- Name: **repofloor** (GitHub org, .com/.dev, npm scope all free as of 2026-10-15).
- License: MIT.
- Lite = GitHub Action + Pages, no server, no secrets beyond `GITHUB_TOKEN`.
- Full = GitHub App (not OAuth App); authorization mirrors GitHub repo access.
- Agents are first-class actors (`kind: "agent"`, id `agent:<owner>:<name>`), fed by editor/CLI hooks (Claude Code `PostToolUse` first).
- Backend language is free; the only shared contract is `@repofloor/protocol` (JSON).
