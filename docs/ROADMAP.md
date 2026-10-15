# Roadmap

Phases, not dates. Each phase ends with something people can use.

## Phase 0 — Skeleton ✅
- [x] Protocol, reducer (with tests), Pixi engine, simulated demo
- [x] Lite GitHub Action + Pages workflow, dogfooded on this repo
- [x] Docs: architecture, contributing, lite setup

## Phase 1 — Lite polish (community-friendly, no backend)
- [ ] Sprite-sheet support as an *optional* skin layer (keep procedural default)
- [ ] Day/night tint based on the viewer's local time
- [ ] Click an avatar → side panel with their recent PRs/commits
- [ ] "Last 7 days" timeline scrubber replaying `office-state.json` history (Action keeps N snapshots)
- [ ] README badge service (`/badge.svg` with "N online")
- [ ] Localization of UI strings (tr, en first)
- [ ] Accessibility: text alternative of the office (who's doing what) under the canvas

## Phase 2 — Full mode foundation

Ordered: each sub-phase unblocks the next. 2A is prerequisites the later ones need.

- [x] Stack decided: self-hosted TypeScript on plain Postgres ([ADR 0001](adr/0001-full-mode-stack.md))
- [x] `apps/api`: webhook ingestion (signature check, dedup, reducer), REST for snapshots
- [x] `apps/api`: Postgres behind `OfficeStore`; authorize snapshot reads against GitHub repo access
- [x] GitHub App manifest + install flow; Sign in with GitHub

### 2A — `apps/api` hardening (prerequisites) ✅
- [x] **A1** Lift the read check out of `handleOffice` into one `authorizeOfficeRead`, so a
      WebSocket connect can run the identical check (`apps/realtime` depends on this)
- [x] **A2** Atomic ingest: `markDelivered` + `save` in one transaction, closing the crash
      gap that loses an event's effect
- [x] **A3** Operational leftovers: `GET /offices` (the store's `list` has no route),
      structured logs, and the documented single-command Postgres restore ADR 0001 promises

### 2B — `apps/realtime` ✅
- [x] **B1** `PostgresEventPublisher` on `LISTEN`/`NOTIFY` behind the existing `EventPublisher`
      ([ADR 0002](adr/0002-realtime-transport.md))
- [x] **B2** WebSocket server, one channel per office; every socket authorized by asking
      `apps/api` with the caller's own credentials forwarded, so the check that runs is A1's
      and not a copy — session cookie *or* bearer token as the identity
- [x] **B3** Presence with TTL

### 2C — `apps/web` ✅
- [x] **C1** Office page: mount the engine against `GET /office/:owner/:repo`
- [x] **C2** Sign-in and install landing — turns `/auth/install/callback`'s JSON into a page
      (pass `return_to`), `/auth/me` decides what to show
- [x] **C3** Buildings → offices → office navigation, including `partial` said out loud
- [x] **C4** Live: subscribe to the 2B socket, feed `applyEffect`
- [ ] Profile: choose your emoji — needs a write route on the api, so it waits for 2D

### 2D — Run it for real
- [x] **D1** `docker compose up --build` on a machine with Docker; add `realtime` to the file
      — run 2026-10-15. It needed a `.dockerignore`; `pnpm smoke` now covers the whole chain.
- [x] **D1b** `apps/web` in the compose file, behind a Caddy that serves the bundle and proxies
      both services onto one origin — `docker compose up` now gives you a page at :8080
- [ ] **D2** Create the App on github.com and walk webhook + sign-in once against the real thing
      (everything so far is covered only against a faked GitHub)
- [ ] **D3** Periodic resync as the App: mint an installation token, rebuild an office from REST
      (the `collect.ts` shape Lite uses)
- [ ] **D4** Sessions across restarts and instances (`SessionStore`) — only when running in more
      than one place actually hurts

## Phase 1.5 — The floor people actually see

Pinned reference and the full reading: [VISUAL_TARGET](VISUAL_TARGET.md). Cheapest first;
none of it is scheduled, and Phase 2 stays ahead of it.

- [x] Per-actor status strip under the canvas (name · emoji · what they are doing) — also
      most of #15, the accessibility text alternative. Done in `apps/web` (2C); the Lite
      page in `apps/demo` still has neither
- [x] Running activity log of recent events, which is what makes the page readable on a phone.
      Same: `apps/web` only, and `apps/demo` could lift `src/describe.ts` wholesale
- [ ] Rooms as architecture: interior walls, doorways, a corridor — not tinted regions
- [ ] Furniture parameterised by room kind (meeting table, sofa, plants), still procedural
- [ ] Palette pass: desaturated furniture, colour reserved for people

## Phase 3 — Agents
- [ ] Agent tokens; `POST /agent/events`
- [ ] Claude Code hook script (`PostToolUse`, `Stop`) — one-line install
- [ ] Adapters: Codex CLI, Gemini CLI, Cursor, Aider
- [ ] Robot avatars per provider, tool-trail bubble, "pair programming" pose next to the owner

## Phase 4 — Rooms & chat
- [ ] Team rooms auto-created from GitHub Teams
- [ ] Custom rooms, focus room (DND), transient PR-review huddles
- [ ] Room chat (7-day retention), @mentions, link previews for PRs/issues
- [ ] Walk-to-talk: proximity bubbles on the floor

## Later / ideas
- Multi-building campus view for orgs with many repos ("active repos" filter)
- Office themes (startup loft, space station, Ottoman han…)
- Sound: keyboard clatter, merge jingle (opt-in)
- Embeds: `<iframe>` widget for docs sites
- Self-hosted Full mode as a one-click template
