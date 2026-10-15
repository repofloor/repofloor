# Architecture

Repofloor is one engine with two delivery modes. Everything below is designed so the
cheap mode (Lite) and the hosted mode (Full) never fork.

## The one rule

> **The renderer only consumes `OfficeState` / `OfficeEvent`. It never knows where they came from.**

```
                 ┌──────────────────────┐
  GitHub REST ──▶│ apps/lite-action     │──▶ office-state.json ──┐
  (Action, cron) │  collect → replay    │                        │
                 └──────────────────────┘                        ▼
                                                       ┌──────────────────┐
  GitHub App ───▶ apps/api ──▶ events ──▶ apps/realtime│ packages/engine  │
  webhooks        (reducer)   (Redis)    (WebSocket) ──▶  Pixi.js office  │
                                                       └──────────────────┘
  Agent hooks ──▶ apps/api ─────────────────▲
  (Claude Code,                             │
   Codex, …)                       packages/reducer runs in all three places
```

## Packages

### `packages/protocol`
Plain-JSON types. `OfficeState` (a snapshot), `OfficeEvent` (a change), hierarchy
(`Building ▸ Office ▸ Room`), `Actor` (human | agent | bot), `ActivityStatus`.
`PROTOCOL_VERSION` is semver; consumers reject a different major.

### `packages/reducer`
`reduce(state, event) → state`, `decay(state, now)`, `replay(state, events, now)`, and
`githubToEvents(webhook)`. Pure and deterministic: no I/O, no `Date.now()`. The same
function runs in the Action, on the server, and in the browser. Status priorities keep
noisy webhooks from flickering avatars; time decay turns silence into idle → offline.

### `packages/engine`
`OfficeRenderer`: `mount(el)`, `setState(state)`, `applyEffect(event)`. Diffs actors by
id so avatars *walk* to new positions. Procedural pixel art (no sprite sheets): a
contributor can run the whole thing with `pnpm dev` and nothing else. Layout is a pure
function of state (`computeLayout`) so positions are stable across reloads.

## Lite mode (shipped)

- `apps/lite-action` runs on push/PR/issue/CI events and on an hourly cron.
- It calls the REST API with the default `GITHUB_TOKEN`: contributors, recent commits,
  PRs, issues, workflow runs. Converts them to events, replays through the reducer,
  writes `office-state.json` next to the prebuilt static page, and the workflow
  publishes both to GitHub Pages.
- The page fetches `./office-state.json`; if it exists the simulator is skipped.
- No presence, chat, rooms, or agent telemetry: those need a server.
- Privacy: only data already visible on GitHub to anyone who can see the repo. For
  private repos, the Pages site must be set to private (Enterprise) or not used.

## Full mode (planned)

### Identity & authorization
A **GitHub App** (not an OAuth App). Installing it on an org/user grants webhooks and an
installation token; "Sign in with GitHub" through the same App gives user identity.
Authorization mirrors GitHub exactly: you can enter an office iff you can read the repo.
No second permission system.

### Hierarchy
`Installation → Building (org/user) → Office (repo) → Room`. Team rooms are created
automatically from GitHub Teams with access to the repo; users can add custom rooms;
PR reviews spawn transient meeting rooms.

### Services
| Service | Responsibility | Notes |
|---|---|---|
| `apps/api` | Verify webhook signatures, `githubToEvents`, persist, publish | Shipped: Postgres store (in-memory without `DATABASE_URL`), reads authorized against GitHub repo access. Idempotent on delivery id; periodic full resync per office |
| `apps/realtime` | WebSocket fan-out per office, presence with TTL; rooms and chat later | Presence is in-process and never written to Postgres. Every socket is authorized by asking `apps/api` with the caller’s own credentials forwarded, so the check that runs is the one behind `GET /office/...` and not a copy ([ADR 0002](adr/0002-realtime-transport.md)) |
| `apps/web` | Buildings list, office view (engine), status strip and activity log; profile later | Shipped (2C): Vite + TypeScript, no framework. Served from the **same origin** as api and realtime — the session cookie is `SameSite=Lax`, and `/office/...` is routed by the `Upgrade` header (socket → realtime, GET → api). Decides nothing about access: it renders the api's answer |

Storage: Postgres (installations, rooms, profiles, agent tokens, 7-day chat). Decided in
[ADR 0001](adr/0001-full-mode-stack.md): self-hosted services on **plain** Postgres,
Supabase not adopted as the platform — its RLS-authorized Realtime would need a mirrored
`repo_access` table, and rule 6 forbids a second ACL. Redis is deferred: pub/sub starts
in-process, then Postgres `LISTEN`/`NOTIFY`, and Redis arrives only when presence volume
demands it. `apps/api` already declares the seam (`OfficeStore`, `EventPublisher`), so
each of those is a one-file change.

### Agents
Each user mints an agent token. Claude Code's `PostToolUse` hook (and adapters for
Codex, Gemini CLI, …) POSTs `{tool, target}` to `apps/api`, which emits
`agent.tool_call` events. Targets are truncated client-side; no file contents ever leave
the machine. Agents render as robots owned by their human, with a rolling tool trail.

### Scale notes
Large orgs: show "active in the last 7 days" offices by default. Webhooks are
best-effort: dedup by delivery id and reconcile with REST every N minutes. One office =
one Redis channel.

## Conventions
- Node ≥ 20, pnpm workspaces, TypeScript strict. ESM only.
- Tests: `node --test` via tsx. Reducer changes **must** come with a test.
- Protocol changes **must** bump `PROTOCOL_VERSION` and update `docs/PROTOCOL.md`.
- Visual changes: attach a screenshot of `apps/demo` to the PR.
