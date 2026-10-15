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
- [x] Stack decided: self-hosted TypeScript on plain Postgres ([ADR 0001](adr/0001-full-mode-stack.md))
- [ ] GitHub App manifest + install flow; Sign in with GitHub
- [x] `apps/api`: webhook ingestion (signature check, dedup, reducer), REST for snapshots
- [ ] `apps/api`: Postgres behind `OfficeStore`; authorize snapshot reads against GitHub repo access
- [ ] `apps/realtime`: per-office WebSocket, presence with TTL
- [ ] `apps/web`: buildings → offices → office view
- [ ] Profile: choose your emoji
- [ ] Deploy: one Docker Compose (api + realtime + Postgres + Redis)

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
