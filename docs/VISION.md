# Vision & decision log

This file preserves the founder's original requests (as stated, 2026-10-15, translated from
Turkish) and every product decision taken since. When a doc and this file disagree, this file
explains *why*; the doc explains *what*. Append, don't rewrite.

## Original requests (Ali Osman, 2026-10-15)

> **1.** An HTML5 page, like a GitHub feature, that shows a real-office-like environment for the
> people and the work in a project — animated. Even show the agents currently working on a
> connected task (e.g. Claude Code) live.

> **2.** I don't want a single language like .NET; it must work for every project on GitHub.
> If auth is needed we add GitHub login, and from there every project the user belongs to becomes
> one office. Organizations are companies; every repo inside is an office inside the company.
> Every character can change their own emoji. There is movement inside the office. People in a
> repo can chat in chat rooms while working. Their own rooms or team rooms can be created.
> Many such features can come — let's design an infrastructure that fits this.
> As a base feature, a more limited but free version on GitHub Pages that anyone can add to
> their own project would be nice.

> **3.** Let's build this as an extensible infrastructure. While developing, make the GitHub repo
> public so anyone can join and contribute. Set up an organization for this repo, create repos
> inside it, and contributors can see the office environment there too.

> **4.** Pick the project name by checking GitHub and the internet — something free, with no
> clashes, usable as a domain later.

> **5.** `github.com/aliosmanmho` is my account; we won't create a new user (the org lives under it).

> **6.** I'll continue the project in Claude Code — give me the files in a form suited to that.

## How each request maps to the codebase

| Request | Where it lives | Status |
|---|---|---|
| Animated office page | `packages/engine`, `apps/demo` | ✅ v0 |
| Live agents (Claude Code etc.) | `Actor.kind = "agent"`, `agent.tool_call` events, robot avatars with tool trail | ✅ protocol + engine; hook adapters in Phase 3 |
| Language-agnostic, any GitHub project | Only contract is JSON (`@repofloor/protocol`); Lite uses GitHub REST only | ✅ |
| GitHub login, every project = office | GitHub App + `Building ▸ Office ▸ Room` hierarchy | 📐 designed (`docs/ARCHITECTURE.md`), Phase 2 |
| Org = company, repo = office | `Building` (org/user) → `Office` (repo) | ✅ protocol; UI in Phase 2 |
| Per-character emoji | `Actor.emoji`, `actor.emoji` event | ✅ protocol + engine; picker UI Phase 2 |
| Movement inside the office | Avatars walk between desk/room/lounge; idle wandering | ✅ v0 (straight lines; A* planned) |
| Chat rooms while working | `chat.message`, `Room` kinds `team/custom/meeting/focus` | ✅ protocol + engine seating; chat service Phase 4 |
| Own rooms / team rooms | `room.created`, team rooms auto from GitHub Teams | ✅ protocol; Phase 4 |
| Extensible infrastructure | Monorepo, engine/reducer/protocol split, mode-agnostic | ✅ |
| Free limited GitHub Pages version | `apps/lite-action` + `office.yml` | ✅ shipped |
| Public repo, community contributions | MIT, CONTRIBUTING, templates, good-first-issues | ✅ |
| Org with repos, contributors see the office | `repofloor` org (to be created), repo dogfoods itself to Pages | ⏳ org creation is manual |
| Clash-free name + domain | Research below | ✅ `repofloor` |
| Claude Code ready | `CLAUDE.md`, `docs/HANDOFF.md` | ✅ |

## Decisions

- **2026-10-15 · Name = repofloor.** Checked GitHub (user/org), `.com`, `.dev`, npm, PyPI — all free; no product with that
  name on the web. Alternatives also free: `gitfloor`, `repolobby`. Rejected (taken somewhere): commitroom, mergeroom,
  pullroom, repotown, pixelfloor (.com), codefloor, repoverse, floorplan, gitcampus (GitHub). Suggested domain: `repofloor.dev`.
- **2026-10-15 · License = MIT.** Maximum contribution; hosted Full mode can still be a product.
- **2026-10-15 · One engine, two modes.** Lite (Action → static) and Full (hosted) share engine, protocol, reducer. Never fork.
- **2026-10-15 · Full mode auth = GitHub App**, not OAuth App; authorization mirrors GitHub repo access, no second ACL.
- **2026-10-15 · Agents are first-class actors**, owned by a human, fed by editor/CLI hooks; only `{tool, target}` leaves the machine.
- **2026-10-15 · Procedural pixel art by default**, no asset pipeline; sprite skins optional later.
- **2026-10-15 · Org lives under @aliosmanmho**; no new GitHub user.
- **2026-10-15 · Not a surveillance tool.** Show *what* people do, never *how long*; detail level is a per-user setting (Full mode).
- ~~**2026-10-15 · First stack for Full mode is open** — Supabase vs. self-hosted Postgres+Redis to be decided in an ADR
  (`docs/adr/0001-full-mode-stack.md`) before `apps/api` starts.~~ Decided below.
- **2026-10-15 · Full mode stack = self-hosted TypeScript on plain Postgres** (`docs/adr/0001-full-mode-stack.md`).
  Supabase was rejected as the *platform*, not as a database: its strongest feature, RLS-authorized Realtime, cannot
  express "can this user read this repo on GitHub" without a mirrored `repo_access` table — a second ACL, which rule 6
  forbids. Redis is deferred (in-process fan-out → Postgres `LISTEN`/`NOTIFY` → Redis only if presence volume demands it).
  The database stays replaceable, so managed Postgres (Neon, RDS, even Supabase's) remains a deployment detail.
  Cost: ~$6-12/month for one VPS, against ~$25/month Supabase Pro. The deciding factor was lock-in: the exit cost from
  this decision is a connection string, and it is cheapest to take now, with no users to migrate.
- **2026-10-15 · Lite aims for ~30s freshness, not real time.** One workflow job (snapshot + deploy
  together), `cancel-in-progress: false` so a running snapshot is never restarted, `pull_request_target`
  so PR events can publish too, and the page re-reads its snapshot every 15s with a conditional request.
  The Actions queue is the floor; sub-second presence stays a Full-mode feature.

## Open questions (for the next conversation)

- Visual style: pixel-art (current) was chosen implicitly by the prototype; isometric/modern was offered and not decided.
- Chat retention, who can create rooms (anyone with write access?), whether rooms are per repo or per org.
- Should Lite also support a *user* building (all my repos on one page) via a profile-repo workflow?
