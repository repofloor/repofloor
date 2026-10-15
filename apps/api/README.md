# apps/api

The ingestion service for **Full mode**: it receives GitHub App webhooks, verifies their
signature, turns them into `OfficeEvent[]` with `githubToEvents` from
`@repofloor/reducer`, applies them with `reduce`, and serves the resulting `OfficeState`
over HTTP.

Stack per [ADR 0001](../../docs/adr/0001-full-mode-stack.md): self-hosted TypeScript on
plain Postgres. Storage is Postgres when `DATABASE_URL` is set and in-memory otherwise;
reads are authorized against GitHub. Realtime fan-out is still a stub behind
`EventPublisher` (see [Storage and realtime](#storage-and-realtime)).

It is plain `node:http`. The only runtime dependency beyond the two workspace packages is
[`pg`](https://node-postgres.com/), imported lazily — without `DATABASE_URL` it is never
loaded.

## Routes

| Route | What it does |
|---|---|
| `POST /webhook` | A GitHub App delivery. Requires `X-Hub-Signature-256`, `X-GitHub-Event` and `X-GitHub-Delivery`. Answers `202` with `{officeId, events, applied}`. |
| `GET /office/:owner/:repo` | The current snapshot as `OfficeState` JSON, with time decay applied. Open for public offices; a private one needs a GitHub token — see [Who may read an office](#who-may-read-an-office). `404` for an office that has had no deliveries. |
| `GET /healthz` | `{ok: true, protocolVersion}`. |

Deliveries are idempotent: event ids are derived from the delivery id, so GitHub
re-sending the same webhook applies nothing the second time (`applied: 0`). With Postgres
behind the store that holds across a restart too.

Unmapped events (`star`, `fork`, …) and deliveries without a `repository` (such as
`ping`) are accepted and ignored — `202` with `events: 0`.

## Run it

```bash
pnpm install
pnpm build                      # packages must be built first; @repofloor/* resolve through dist
WEBHOOK_SECRET=dev-secret pnpm --filter @repofloor/api dev
```

That runs with the in-memory store: good for a quick look, but snapshots are lost on
restart. With a database:

```bash
DATABASE_URL=postgres://repofloor:repofloor@localhost:5432/repofloor \
WEBHOOK_SECRET=dev-secret pnpm --filter @repofloor/api dev
```

Migrations run at startup, so the first boot creates the schema itself. Or bring up api
and Postgres together from the repository root:

```bash
WEBHOOK_SECRET=dev-secret docker compose up --build
```

`dev` runs `tsx watch`; `pnpm --filter @repofloor/api start` runs the compiled
`dist/server.js`.

| Variable | Default | Meaning |
|---|---|---|
| `WEBHOOK_SECRET` | — | **Required.** The GitHub App webhook secret. The service refuses to start without it. |
| `DATABASE_URL` | — | Postgres connection string. Unset means the in-memory store: no database needed, nothing survives a restart. |
| `DATABASE_SSL` | — | `require` (verify the certificate), `no-verify`, or `disable`. Unset leaves it to the connection string. |
| `DATABASE_POOL_MAX` | `pg`'s default (10) | Max pooled connections. |
| `EVENT_RETENTION_DAYS` | `7` | How long applied event ids are kept before the hourly retention cut drops them. |
| `ACCESS_TTL_MS` | `60000` | How long a repo-read decision is cached per (caller, repo). |
| `GITHUB_API_URL` | `https://api.github.com` | Point at GHES, or at a stub in a staging environment. |
| `PORT` | `8787` | |
| `HOST` | `0.0.0.0` | |

## Storage

Postgres, plain SQL, no ORM and no extension — ADR 0001 wants the database to stay a
connection string, so a managed provider is only a deployment detail.

| Table | Holds |
|---|---|
| `offices` | One row per office: `office_id`, the snapshot as `jsonb`, timestamps. |
| `applied_events` | One row per applied `OfficeEvent` id, which is derived from the GitHub delivery id. Its primary key *is* the dedup mechanism. |
| `schema_migrations` | Which numbered migration files this database has seen. |

Migrations are numbered `.sql` files in [migrations/](migrations), applied in version
order by the runner in [src/db.ts](src/db.ts): each in its own transaction, serialized
across processes by a session advisory lock, so two api instances booting together cannot
apply the same file twice. There is no separate migrate command — the server runs pending
migrations on startup.

`applied_events` would otherwise grow forever, so the server prunes ids older than
`EVENT_RETENTION_DAYS` at startup and hourly after that. GitHub does not re-deliver
anything that old.

## Who may read an office

`GET /office/:owner/:repo` is authorized, and **GitHub is the only ACL** (CLAUDE.md rule
6). There is no permissions table here; nothing in Postgres is consulted to decide who
may read.

- **Public offices are open.** An office is public exactly when a signed delivery said so
  (`office.private === false` in the snapshot). An office whose visibility we were never
  told is treated as private — fail closed.
- **A private office needs a GitHub token**, presented as
  `Authorization: Bearer <token>`. The service asks GitHub
  `GET /repos/{owner}/{repo}` *with that token*: a `200` means the caller can see the
  repository, which is exactly "may read". The answer is cached by (caller, repo) for
  `ACCESS_TTL_MS`, and dropped immediately when an `installation_repositories` or
  `member` delivery says access changed.

| Situation | Answer |
|---|---|
| Public office | `200` |
| Private office, no token | `401 {"error": "authentication_required"}` plus `WWW-Authenticate` |
| Private office, token GitHub rejects | `404 {"error": "unknown_office"}` — deliberately the same answer as an office that does not exist, because whether a private repository exists is itself private. That is how GitHub's own API answers. |
| GitHub unreachable or 5xx | `503 {"error": "access_check_unavailable"}`, and nothing is cached |

**The identity seam, stated plainly:** the token *is* the identity. The service never
learns a login, never stores the token (cache keys are a per-process salted hash) and
holds no session. A "Sign in with GitHub" flow — an App installation, a session cookie,
a token the browser never sees — is a later slice; `apps/web` will exchange it for
whatever this endpoint accepts then. A user access token works today:

```bash
curl -s -H "authorization: Bearer $(gh auth token)" \
  localhost:8787/office/<owner>/<private-repo> | jq '.actors | length'
```

## Point a GitHub App at it

1. Create a GitHub App (Settings → Developer settings → GitHub Apps → New).
2. **Webhook URL**: your public URL + `/webhook`. For local development, tunnel it —
   `gh webhook forward --repo <owner>/<repo> --events '*' --url http://localhost:8787/webhook`
   or any tunnel of your choice.
3. **Webhook secret**: the same value you pass as `WEBHOOK_SECRET`.
4. Repository permissions, all read-only: Contents, Issues, Pull requests, Actions,
   Checks, Metadata.
5. Subscribe to events: Push, Pull request, Pull request review, Pull request review
   comment, Issues, Issue comment, Workflow run, Check suite, plus Member and Repository
   (the last two are what invalidate cached read decisions).
6. Install the App on a repository, then do something in that repository and read the
   office back:

```bash
curl -s localhost:8787/office/<owner>/<repo> | jq '.actors[] | {id: .actor.id, status, detail}'
```

### Send a delivery by hand

```bash
BODY='{"repository":{"full_name":"o/r","name":"r","private":false,"owner":{"login":"o","type":"User"}},"ref":"refs/heads/main","commits":[{"id":"a"}],"sender":{"login":"o"}}'
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

No database and no network needed: everything is either a fake or a real server on a
loopback port.

- `tests/signature.test.ts` — HMAC verification (good, tampered, wrong secret, missing,
  `sha1=`, repeated header).
- `tests/webhook.test.ts` — a real server over `fetch`: webhook → events → state →
  `GET /office/:owner/:repo`, plus rejection, re-delivery, no-op deliveries, error shapes.
- `tests/access.test.ts` — the repo-read check against a fake GitHub: allow, refuse,
  per-caller keying, TTL expiry, webhook invalidation, outage behaviour, cache cap.
- `tests/office-access.test.ts` — the same rules over HTTP: public open, private `401`,
  token accepted, token refused `404`, unknown visibility closed, `503` on outage.
- `tests/store-postgres.test.ts` — the SQL the store sends, against a recording fake,
  **plus one integration test that is skipped unless `DATABASE_URL` is set**:

```bash
DATABASE_URL=postgres://repofloor:repofloor@localhost:5432/repofloor \
  pnpm --filter @repofloor/api test
```

It runs the real migrations (twice, to prove they are idempotent) and the real store
against that database, then cleans up the rows it made. Point it at a throwaway
database — `docker compose up postgres` is one.

## Storage and realtime

`OfficeStore` ([src/store.ts](src/store.ts)) — `load` / `save` / `markDelivered` /
`list` — now has two implementations: `PostgresOfficeStore`
([src/store-postgres.ts](src/store-postgres.ts)) and `InMemoryOfficeStore`, picked by
whether `DATABASE_URL` is set. The interface did not change; nothing above it knows which
one it is talking to.

Still a stub: `EventPublisher` ([src/publisher.ts](src/publisher.ts)) —
`publish({officeId, events, state})`, fire-and-forget, currently dropping everything.
`apps/realtime` consumes it over Postgres `LISTEN`/`NOTIFY` first, Redis pub/sub if
presence volume demands it.

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
- `markDelivered` and `save` are two statements, not one transaction: a crash between
  them records an event id whose effect was never persisted, and that one event is then
  lost (the next delivery still lands). Closing the gap means a transaction spanning the
  ingest loop, which the `OfficeStore` interface deliberately does not expose yet — it
  would be the first change worth making to it, next to a periodic full resync.
- A read decision is cached for a minute, so losing access can take up to a minute to
  take effect unless a `member` or `installation_repositories` delivery arrives first.
  ADR 0001 accepts that; the alternative is a GitHub API call per request.
