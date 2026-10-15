# Repofloor — project memory for Claude Code

A living pixel office for every GitHub repository. Org = building, repo = office, contributors
= avatars at desks, coding agents = robots. Two delivery modes share ONE engine:
**Lite** (GitHub Action → static page on Pages, shipped) and **Full** (hosted, GitHub App,
live presence, rooms, chat, agent telemetry — Phase 2+, not started).

Read `docs/ARCHITECTURE.md` before touching anything beyond a single package.
Current state and next steps: `docs/HANDOFF.md`. Founder's original requests and the decision log: `docs/VISION.md` (append decisions there).
Decisions that need their reasoning kept get an ADR in `docs/adr/NNNN-slug.md` (context, options, decision, consequences) plus a one-paragraph entry in `docs/VISION.md`.

## Commands

```bash
pnpm install                 # Node >= 20, pnpm >= 9
pnpm build                   # packages → demo → lite-action bundle (order matters)
pnpm dev                     # demo with simulated team, http://localhost:5173
pnpm test                    # node --test via tsx (protocol, reducer, lite-action, api)
pnpm typecheck
pnpm smoke                   # 12 checks against a RUNNING compose stack (docker compose up first)
pnpm --filter @repofloor/reducer test   # single package
```

Playwright screenshot of the demo (used for README / visual checks):
`pnpm --filter @repofloor/demo preview --port 4173` then screenshot `#office` with Playwright.

## Layout

```
packages/protocol   OfficeState / OfficeEvent contract. Plain JSON types, zero deps. PROTOCOL_VERSION semver.
packages/reducer    reduce(state, event), decay(state, now), replay(), githubToEvents(webhook). PURE.
packages/engine     Pixi.js v8 renderer. OfficeRenderer.mount/setState/applyEffect. Procedural pixel art.
apps/demo           Vite app; simulator.ts fakes a team + 2 agents. Also the static page Lite publishes.
apps/lite-action    GitHub Action. collect.ts (REST → events → replay) + main.ts. dist/index.js IS COMMITTED.
apps/api            GitHub App webhook receiver (Full mode). Signature check → githubToEvents → reduce → GET /office/:owner/:repo.
                    Store and publisher are interfaces with in-memory impls (ADR 0001). No runtime deps.
apps/realtime       ws fan-out per office. OfficeHub (no socket knowledge) + socket.ts (ws) + access.ts
                    (authorizes by asking apps/api, forwarding the caller’s credentials). Presence is in-process,
                    TTL’d, never persisted, and expressed as actor.upsert / actor.leave (ADR 0002).
apps/web            Planned (Full mode). README stub only.
docs/               ARCHITECTURE, PROTOCOL, LITE, ROADMAP, CONTRIBUTING-adjacent docs, HANDOFF
```

## Hard rules

1. **Engine never knows the data source.** It consumes `OfficeState`/`OfficeEvent` only. Lite and Full must not fork.
2. **Reducer is pure.** No I/O, no `Date.now()`; time comes from `event.at`. Every reducer change ships with a test in `packages/reducer/tests/`.
3. **Protocol changes**: additive → bump minor; breaking → bump major in `PROTOCOL_VERSION` and update `docs/PROTOCOL.md`.
4. **`apps/lite-action/dist/index.js` must be rebuilt and committed** whenever `packages/*`, `apps/demo` or `apps/lite-action/src` change (CI checks it: `git diff --exit-code apps/lite-action/dist`). `dist/site/` (the demo build) is committed too; `*.map`, `*.d.ts`, `collect.js`, `main.js` are ignored.
5. **Procedural first.** Default visuals need no asset files. Skins/sprite sheets are optional layers later.
6. **Mirror GitHub permissions** in Full mode; never invent a second ACL. Not a surveillance tool: show *what*, not *how long*.
7. ESM only, TypeScript strict (`exactOptionalPropertyTypes` is on except in `packages/engine`, where Pixi types conflict).

## Gotchas

- Pixi v8: `new Application(); await app.init({...})`; Graphics API is `g.rect().fill()`. Don't name a Container subclass field `label` (collides with `Container.label`).
- `Omit<UnionType, K>` collapses the union — use the distributive helper pattern in `apps/lite-action/src/collect.ts`.
- `pnpm -r run build` must build packages before apps; root `build` script already orders it.
- Demo fetches `./office-state.json`; if present (Lite), the simulator is skipped.
- Layout is deterministic from state (`computeLayout`); desk order is by `hash(login)`, not alphabetical, on purpose.
- Status priority table lives in `packages/reducer/src/index.ts` (`PRIORITY`) and `docs/PROTOCOL.md` — keep them in sync.

## Conventions

- Commits: `feat:`, `fix:`, `docs:`, `chore:` prefixes. Small PRs.
- Visual changes → attach a screenshot of `pnpm dev` to the PR.
- Language: code, docs and commit messages in English; the maintainer (Ali Osman, @aliosmanmho) is Turkish-speaking — conversation can be in Turkish.
