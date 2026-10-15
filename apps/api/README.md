# apps/api

The ingestion service for **Full mode**: it receives GitHub App webhooks, verifies their
signature, turns them into `OfficeEvent[]` with `githubToEvents` from
`@repofloor/reducer`, applies them with `reduce`, and serves the resulting `OfficeState`
over HTTP.

Stack per [ADR 0001](../../docs/adr/0001-full-mode-stack.md): self-hosted TypeScript on
plain Postgres. This skeleton is the first slice of it — no database and no realtime
fan-out yet, both behind interfaces (see [Storage and realtime](#storage-and-realtime)).

It is plain `node:http` with no runtime dependencies beyond the two workspace packages.

## Routes

| Route | What it does |
|---|---|
| `POST /webhook` | A GitHub App delivery. Requires `X-Hub-Signature-256`, `X-GitHub-Event` and `X-GitHub-Delivery`. Answers `202` with `{officeId, events, applied}`. |
| `GET /office/:owner/:repo` | The current snapshot as `OfficeState` JSON, with time decay applied. `404` for an office that has had no deliveries. |
| `GET /healthz` | `{ok: true, protocolVersion}`. |

Deliveries are idempotent: event ids are derived from the delivery id, so GitHub
re-sending the same webhook applies nothing the second time (`applied: 0`).

Unmapped events (`star`, `fork`, …) and deliveries without a `repository` (such as
`ping`) are accepted and ignored — `202` with `events: 0`.

## Run it

```bash
pnpm install
pnpm build                      # packages must be built first; @repofloor/* resolve through dist
WEBHOOK_SECRET=dev-secret pnpm --filter @repofloor/api dev
```

`dev` runs `tsx watch`; `pnpm --filter @repofloor/api start` runs the compiled
`dist/server.js`.

| Variable | Default | Meaning |
|---|---|---|
| `WEBHOOK_SECRET` | — | **Required.** The GitHub App webhook secret. The service refuses to start without it. |
| `PORT` | `8787` | |
| `HOST` | `0.0.0.0` | |

## Point a GitHub App at it

1. Create a GitHub App (Settings → Developer settings → GitHub Apps → New).
2. **Webhook URL**: your public URL + `/webhook`. For local development, tunnel it —
   `gh webhook forward --repo <owner>/<repo> --events '*' --url http://localhost:8787/webhook`
   or any tunnel of your choice.
3. **Webhook secret**: the same value you pass as `WEBHOOK_SECRET`.
4. Repository permissions, all read-only: Contents, Issues, Pull requests, Actions,
   Checks, Metadata.
5. Subscribe to events: Push, Pull request, Pull request review, Pull request review
   comment, Issues, Issue comment, Workflow run, Check suite.
6. Install the App on a repository, then do something in that repository and read the
   office back:

```bash
curl -s localhost:8787/office/<owner>/<repo> | jq '.actors[] | {id: .actor.id, status, detail}'
```

### Send a delivery by hand

```bash
BODY='{"repository":{"full_name":"o/r","name":"r","owner":{"login":"o","type":"User"}},"ref":"refs/heads/main","commits":[{"id":"a"}],"sender":{"login":"o"}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')"
curl -s -X POST localhost:8787/webhook \
  -H "content-type: application/json" \
  -H "x-github-event: push" \
  -H "x-github-delivery: $(uuidgen)" \
  -H "x-hub-signature-256: $SIG" \
  -d "$BODY"
```

## Test

```bash
pnpm --filter @repofloor/api test
```

`tests/signature.test.ts` covers HMAC verification (good, tampered, wrong secret,
missing, `sha1=`, repeated header). `tests/webhook.test.ts` drives a real server over
`fetch`: webhook → events → state → `GET /office/:owner/:repo`, plus rejection,
re-delivery, no-op deliveries and error shapes.

## Storage and realtime

Two interfaces are the seam the rest of Full mode plugs into. Both are marked `TODO` and
ship with in-memory implementations, so **snapshots are lost on restart** and nothing is
broadcast yet.

- `OfficeStore` ([src/store.ts](src/store.ts)) — `load` / `save` / `markDelivered` /
  `list`. Postgres next: snapshot per office plus a unique index on the delivery id,
  which makes dedup survive restarts.
- `EventPublisher` ([src/publisher.ts](src/publisher.ts)) — `publish({officeId, events,
  state})`, fire-and-forget. `apps/realtime` consumes this over Postgres
  `LISTEN`/`NOTIFY` first, Redis pub/sub if presence volume demands it.

Also not done yet: `GET /office/:owner/:repo` is **unauthorized**. Full mode must check
GitHub repo access per request (CLAUDE.md rule 6 — GitHub is the only ACL), so until
that lands, only run this against public repositories.

## Design notes

- The signature is verified over the **raw** body bytes before parsing. Re-serializing
  parsed JSON changes the digest, and an unverified payload is attacker-controlled
  input we should not spend work on.
- The reducer is imported, not reimplemented. The same `githubToEvents` and `reduce`
  run in the Lite action and in the browser; this service adds storage and transport
  and nothing else.
- Repo metadata (description, default branch, visibility) is refreshed from every
  delivery — the newest payload wins.
- Bodies above 25 MB are refused with `413` without being buffered (GitHub's own limit).
