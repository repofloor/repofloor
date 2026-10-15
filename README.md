<p align="center">
  <img src="docs/assets/office.png" alt="Repofloor demo office" width="720" />
</p>

<h1 align="center">🏢 Repofloor</h1>

<p align="center"><b>A living pixel office for every GitHub repository.</b><br/>
Your org is the building, each repo is an office, every contributor has a desk — and your coding agents sit right next to you.</p>

<p align="center">
  <a href="https://github.com/repofloor/repofloor/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/repofloor/repofloor/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-purple.svg"></a>
  <a href="https://repofloor.github.io/repofloor/"><img alt="Office" src="https://img.shields.io/badge/🏢-visit%20our%20office-6d28d9"></a>
</p>

---

## What is this?

Repofloor turns GitHub activity into an animated 2D office:

| GitHub | Office |
|---|---|
| Organization / user | 🏬 Building |
| Repository | 🏢 Office |
| GitHub Team / custom room | 🚪 Room (chat, meeting, focus) |
| Contributor | 🧑‍💻 Avatar at a desk, with their chosen emoji |
| Coding agent (Claude Code, Codex, Gemini CLI, …) | 🤖 Robot avatar whose thought bubble shows its last tool calls |
| Push / commit | typing animation |
| PR review requested | walks over with a 🔍 |
| CI running / failed | ⚙️ spinning gear / ❗ and the office lamp turns red |
| Merge | 🎉 confetti |

It ships in two flavours that share the **same engine**:

- **Lite** — free, serverless. A GitHub Action snapshots your repo's recent activity into `office-state.json` and publishes a static office to GitHub Pages. One workflow file, no secrets, no server. *Available now.*
- **Full** — hosted. Sign in with GitHub, see every repo you have access to as an office, live presence, agent telemetry, rooms and chat. *In progress — see [ROADMAP](docs/ROADMAP.md).*

This repository dogfoods itself: **[visit our office →](https://repofloor.github.io/repofloor/)**
Drag to pan, scroll or use the **+ / −** buttons to zoom, double-click to fit the whole floor.

## Add the Lite office to your repo (2 minutes)

1. Create `.github/workflows/office.yml`:

```yaml
name: Repofloor office
on:
  push: { branches: [main] }
  pull_request_target: { types: [opened, closed, reopened, review_requested] }
  schedule: [{ cron: "17 * * * *" }]
  workflow_dispatch:
permissions: { contents: read, pages: write, id-token: write, actions: read, pull-requests: read, issues: read }
concurrency: { group: repofloor-office, cancel-in-progress: false }
jobs:
  office:
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: "${{ steps.deployment.outputs.page_url }}" }
    steps:
      - uses: repofloor/repofloor/apps/lite-action@main
      - uses: actions/upload-pages-artifact@v5
        with: { path: repofloor-site }
      - id: deployment
        uses: actions/deploy-pages@v5
```

2. In the repo's **Settings → Pages**, set *Source* to **GitHub Actions**.
3. Push. Your office is at `https://<owner>.github.io/<repo>/`.

Details, options and the privacy notes are in [docs/LITE.md](docs/LITE.md).

## Run the demo locally

```bash
pnpm install
pnpm build
pnpm dev          # http://localhost:5173 — simulated team + two agents
```

## Repository layout

```
packages/protocol    Event & state schema — the contract everything speaks     (TypeScript, zero deps)
packages/reducer     GitHub/agent events → OfficeState, pure & deterministic     (shared by Lite and Full)
packages/engine      Pixi.js renderer: desks, rooms, avatars, animations
apps/demo            The engine running on a simulated event stream; also the static page Lite publishes
apps/lite-action     GitHub Action: REST snapshot → office-state.json + static page
apps/api             GitHub App webhooks, snapshots, sign-in                     → docs/ARCHITECTURE.md
apps/realtime        WebSocket fan-out per office, presence                      → docs/adr/0002-realtime-transport.md
apps/web             (planned) hosted UI: buildings, offices, settings
docs/                Architecture, roadmap, contributing
```

## Contributing

Repofloor is built in the open, and the office you see on our Pages site is the people building it. Start with [CONTRIBUTING.md](CONTRIBUTING.md), pick a [`good first issue`](https://github.com/repofloor/repofloor/labels/good%20first%20issue), say hi in Discussions.

## License

[MIT](LICENSE)
