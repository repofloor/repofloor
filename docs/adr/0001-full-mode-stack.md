# ADR 0001 — Full mode stack: Supabase or self-hosted Postgres + Redis

- **Status:** accepted
- **Date:** 2026-10-15
- **Deciders:** @aliosmanmho (sole maintainer)
- **Supersedes:** the open question recorded in `docs/VISION.md`
  ("First stack for Full mode is open")

## Context

Lite mode is shipped: a GitHub Action snapshots a repo into `office-state.json` and
GitHub Pages serves the prebuilt office. Its freshness floor is the Actions queue,
roughly 30-45 seconds. Full mode exists to go below that and to add what a static page
cannot have: live presence, rooms, chat and agent telemetry.

Full mode needs a stack. Four constraints decide it.

1. **One maintainer.** Every moving part has to be worth its operational cost. An
   evening of downtime must be survivable, and the whole thing must be restartable from
   a `docker compose up` plus a database dump.
2. **Webhook to screen in seconds.** A GitHub App delivery has to be verified, turned
   into `OfficeEvent[]`, reduced, persisted and pushed to every connected client of that
   office. The budget is a few hundred milliseconds of our own work; the rest is
   GitHub's delivery latency.
3. **Authorization mirrors GitHub, and we never invent a second ACL**
   (`CLAUDE.md` rule 6). You may enter an office if and only if GitHub says you can read
   the repo. The authority is GitHub's API plus the App installation token — not a table
   we maintain.
4. **`@repofloor/protocol` is the only contract.** The reducer is pure TypeScript and
   must run unchanged in the Action, on the server and in the browser. Any stack that
   makes the server speak a different dialect of the same data is disqualified.

Two concrete proposals were on the table.

## Options considered

### Option A — Supabase (hosted Postgres + Auth + Realtime + Edge Functions)

Supabase bundles managed Postgres, a GitHub auth provider, a Realtime server that
broadcasts row changes authorized by Row Level Security, and Deno-based Edge Functions
for the webhook endpoint.

- **For:** no servers to patch, backups and connection pooling included, a usable
  dashboard, and Realtime removes the need to write `apps/realtime` at all. Fastest
  path to a first deployed Full mode.
- **Against:** the feature Supabase is strongest at is the one constraint 3 forbids us
  from using. RLS can only authorize against data in the database, so gating an office
  channel by RLS means maintaining a `repo_access` table — a second ACL in all but
  name, with its own staleness window. Our real check is "ask GitHub (or the cached
  installation token) whether this user can read this repo", evaluated when a socket
  connects. Doing that in front of Supabase Realtime means putting our own service in
  the path anyway, at which point Realtime is a dependency we pay for and route around.
- **Against:** Supabase Auth's GitHub provider is OAuth-App shaped. Full mode is a
  GitHub **App** (already decided): we still own the installation flow, installation
  tokens and `GET /user/installations`. Auth therefore saves a session cookie and
  little else.
- **Against:** Edge Functions run on Deno. `@repofloor/reducer` is a pnpm workspace
  package; shipping it there means a separate bundling step and a second runtime to
  reason about, for the one piece of code that must behave identically everywhere.
- **Against:** real lock-in surface — `auth.users`, RLS policy files, the Realtime
  channel protocol and the Edge Functions runtime. Leaving later is a rewrite of the
  edges, not a connection-string change.
- **Cost:** the free tier pauses idle projects and caps concurrent Realtime clients, so
  anything public means Pro at roughly $25/month per project from day one.

### Option B — Self-hosted services on plain Postgres, Redis added when needed

`apps/api` (webhook ingestion, REST) and `apps/realtime` (WebSocket fan-out, presence)
are plain Node processes. Postgres holds installations, rooms, profiles, agent tokens
and short-retention chat. One `docker compose up` brings up api + realtime + Postgres
for contributors and for a single-VPS deployment.

- **For:** the authorization check is ordinary code in our own process — call GitHub
  with the installation token, cache the answer with a TTL, done. GitHub stays the only
  ACL.
- **For:** the reducer runs as a workspace import, the same file as the Action and the
  browser use. Constraint 4 holds for free.
- **For:** nothing in the data layer is proprietary. Postgres is Postgres; the database
  can live on the same box, on Neon, on RDS or on Supabase's Postgres without touching
  application code.
- **Against:** we write and operate the WebSocket server, presence TTLs, migrations,
  backups and TLS. That is real work Option A would have donated.
- **Against:** a single process is a single point of failure until there is more than
  one.
- **Cost:** one small VPS at roughly $6-12/month, or free-tier managed Postgres plus a
  container host.

### Option C — Supabase Postgres only, our own api and realtime on top

Option B's architecture with Supabase used purely as a managed database, ignoring Auth,
RLS and Realtime. Viable, and reachable from B at any time, but it is a hosting choice
rather than an architectural one — which is exactly the point below.

## Decision

**Option B.** `apps/api` and `apps/realtime` are self-hosted TypeScript services over
plain Postgres. Supabase is not adopted as the platform.

Three sub-decisions follow from it:

- **Redis is deferred.** Pub/sub starts as in-process fan-out, backed by Postgres
  `LISTEN`/`NOTIFY` as soon as there is a second process. Redis arrives when presence
  volume or horizontal scaling demands it, behind the interfaces `apps/api` already
  declares (`OfficeStore`, `EventPublisher`), so adopting it touches one file.
- **The database stays replaceable.** No Postgres extension, no vendor SQL. A managed
  provider — including Supabase's Postgres — is a deployment detail, and Option C stays
  open with no code change.
- **Authorization is a cached GitHub call**, keyed by (user, repo), with a short TTL and
  invalidation on the `installation_repositories` and `member` webhooks. There is no
  permissions table that anything reads as the source of truth.

## Consequences

**Good**

- The one hard rule is enforceable: GitHub is the only ACL, checked in code we can read.
- Lite and Full genuinely share the reducer; one reducer test covers both.
- Local development needs Docker and nothing else. A contributor can run Full mode.
- Lock-in is a connection string. The exit cost from this decision is near zero, which
  is the real reason to take it now, while there are no users to migrate.

**Bad / accepted**

- `apps/realtime` must be written, including presence TTL, reconnect and backpressure.
  Option A would have given that away.
- Operations are ours: migrations, backups, TLS renewal, upgrades, uptime. Mitigation —
  a managed Postgres from the start, so the stateful part is somebody else's problem,
  and a documented single-command restore.
- No dashboard. Mitigation: `psql`, plus structured logs.
- Slower to a first deploy than Option A, by an estimated week of evenings.

**Risks**

- *Cached permissions go stale* and someone sees an office for a few minutes after
  losing access. Mitigated by a short TTL (60s) and webhook-driven invalidation;
  accepted, because the alternative is a GitHub API call per socket message.
- *Single-box outage* takes Full mode down. Accepted while Full mode is a preview; Lite
  keeps working, since it does not depend on this stack at all.
- *Maintainer bandwidth.* If operations prove to be the bottleneck rather than features,
  revisit — Option C absorbs the database half of the problem without an architecture
  change, which is the planned response, not a new ADR.

## Follow-ups

- `apps/api` skeleton: signature verification, `githubToEvents`, reduce into an office
  state, `GET /office/:owner/:repo` (storage and publishing are interfaces with
  in-memory implementations for now).
- Replace the in-memory `OfficeStore` with Postgres, plus event dedup on delivery id.
- `apps/realtime`: WebSocket fan-out per office, presence with TTL.
- `docker-compose.yml`: api + realtime + Postgres.
- GitHub App manifest and installation flow.
