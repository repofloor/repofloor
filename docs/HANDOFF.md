# Handoff — where the project stands

_Last updated: 2026-10-15 (Phase 2 kick-off: ADR 0001 + apps/api skeleton)._

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
  `GET /healthz`. 12 tests. `apps/api/README.md` has the GitHub App setup and local tunnel instructions.

## Not yet done / known rough edges

- Speech bubbles overlap when several actors in the top desk row talk at once (needs simple collision/stagger).
- Avatars walk in straight lines through desks (A* on the tile grid — issue #5).
- `applyEffect` is called by the demo; Lite page never calls it (no live events) — fine for now.
- No engine unit tests (visual package). A Playwright screenshot workflow is issue #16.
- Lite `collect.ts` does not page beyond 100 commits / 50 PRs / 50 issues / 20 runs.
- `monitors` map redraw happens per `setState` for every actor — cheap, but could be diffed.

## Immediate next steps (suggested order)

1. Phase 1 quick wins: bubble stagger, A* walking (#5), night tint (#4), text alternative under the canvas (#15).
2. Phase 2, next slices of `apps/api` (the ADR and the skeleton are done):
   a. **Postgres behind `OfficeStore`** — snapshot per office + a unique index on the delivery id, so dedup
      and snapshots survive a restart. Today everything is in memory.
   b. **Authorize `GET /office/:owner/:repo`** against GitHub repo access (cached, 60s TTL, invalidated on
      `installation_repositories` / `member`). Until then the service is only safe on public repos.
   c. GitHub App manifest + install flow; persist installations and their tokens.
   d. `apps/realtime`: WebSocket fan-out per office consuming `EventPublisher`, presence with TTL.
   e. `docker-compose.yml`: api + realtime + Postgres.

## Decisions already made

- Name: **repofloor** (GitHub org, .com/.dev, npm scope all free as of 2026-10-15).
- License: MIT.
- Lite = GitHub Action + Pages, no server, no secrets beyond `GITHUB_TOKEN`.
- Full = GitHub App (not OAuth App); authorization mirrors GitHub repo access.
- Agents are first-class actors (`kind: "agent"`, id `agent:<owner>:<name>`), fed by editor/CLI hooks (Claude Code `PostToolUse` first).
- Backend language is free; the only shared contract is `@repofloor/protocol` (JSON).
