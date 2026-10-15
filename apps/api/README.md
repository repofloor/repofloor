# apps/api

The ingestion service for **Full mode**: it receives GitHub App webhooks, verifies their
signature, turns them into `OfficeEvent[]` with `githubToEvents` from
`@repofloor/reducer`, applies them with `reduce`, and serves the resulting `OfficeState`
over HTTP.

Stack per [ADR 0001](../../docs/adr/0001-full-mode-stack.md): self-hosted TypeScript on
plain Postgres. Storage is Postgres when `DATABASE_URL` is set and in-memory otherwise;
reads are authorized against GitHub. It can also sign people in with GitHub and hold the
App's own identity (see [Who may read an office](#who-may-read-an-office) and
[Installing the App](#installing-the-app)). Realtime fan-out is still a stub behind
`EventPublisher` (see [Storage and realtime](#storage-and-realtime)).

It is plain `node:http`. The only runtime dependency beyond the two workspace packages is
[`pg`](https://node-postgres.com/), imported lazily — without `DATABASE_URL` it is never
loaded. Cookies are signed and App JWTs are minted with `node:crypto`; there is no cookie,
JWT or OAuth library.

## Routes

| Route | What it does |
|---|---|
| `POST /webhook` | A GitHub App delivery. Requires `X-Hub-Signature-256`, `X-GitHub-Event` and `X-GitHub-Delivery`. Answers `202` with `{officeId, events, applied}`. |
| `GET /office/:owner/:repo` | The current snapshot as `OfficeState` JSON, with time decay applied. Open for public offices; a private one needs a GitHub token or a session — see [Who may read an office](#who-may-read-an-office). `404` for an office that has had no deliveries. |
| `GET /offices` | Every office the caller may see, as summaries (`{offices, partial}`). Public ones for anyone; private ones only for a caller GitHub vouches for, so the listing cannot leak the *name* of a private repo. `partial: true` means one was omitted because GitHub could not be asked. |
| `GET /healthz` | `{ok: true, protocolVersion, signIn}`. |

These five exist once sign-in is configured, and answer `501 sign_in_not_configured`
until it is — configuration, not a typo:

| Route | What it does |
|---|---|
| `GET /auth/github` | Starts a sign-in: `302` to GitHub, with the `state` also kept in a short-lived signed cookie. Takes an optional `return_to` path. |
| `GET /auth/github/callback` | Exchanges the `code` for a user access token, opens a session, sets the session cookie, `302` back to `return_to`. |
| `GET /auth/me` | `{login, id, avatarUrl, expiresAt}` for the current session, or `401`. Never the token. |
| `POST /auth/logout` | Destroys the session server-side and clears the cookie. `POST` only. |
| `GET /auth/install` | `302` to GitHub's install page for the App (needs `GITHUB_APP_SLUG`). |
| `GET /auth/install/callback` | The App's **Setup URL**: takes `installation_id` and `setup_action`, records the installation. |

Deliveries are idempotent: event ids are derived from the delivery id, so GitHub
re-sending the same webhook applies nothing the second time (`applied: 0`). With Postgres
behind the store that holds across a restart too.

Deliveries for one office are serialized ([src/serialize.ts](src/serialize.ts)):
applying one is read-modify-write over the snapshot and GitHub delivers concurrently,
so overlapping deliveries would otherwise drop each other's events. That holds inside a
process; across processes `OfficeStore.transaction` provides it: the Postgres store
takes a transaction-scoped `pg_advisory_xact_lock` on the office id, which also covers
an office's very first delivery, where there is no row yet to lock.

Ingest is atomic. Marking an event delivered and saving the snapshot it produced are
one transaction, so a crash in between cannot leave the ledger saying "applied" while
the snapshot never saw it — which would lose that event for good, the re-delivery being
deduped away. Publishing happens after the commit, never inside it.

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
| `GITHUB_WEB_URL` | `https://github.com` | Where the *browser* is sent for sign-in. GHES puts it elsewhere than the API. |
| `PORT` | `8787` | |
| `HOST` | `0.0.0.0` | |

Sign-in and the App's own identity are both optional, and each is all-or-nothing: set a
group completely or leave it out. Without them the service behaves exactly as it did
before — every caller presents its own token — and it says so on startup.

| Variable | Needed for | Meaning |
|---|---|---|
| `PUBLIC_BASE_URL` | sign-in | Our own public origin, e.g. `https://repofloor.example`. The OAuth `redirect_uri` and every post-sign-in redirect are built from it, so it must match the App's callback URL. An `https://` value also makes the session cookie `Secure`. |
| `GITHUB_CLIENT_ID` | sign-in | The App's OAuth client id. |
| `GITHUB_CLIENT_SECRET` | sign-in | The App's OAuth client secret. |
| `SESSION_SECRET` | sign-in | Signs the session and `state` cookies. Long and random; rotating it signs everyone out, which is the intended emergency button. |
| `SESSION_TTL_MS` | — | Session lifetime, default 12h. |
| `GITHUB_APP_ID` | acting as the App | The App id, for minting installation tokens. |
| `GITHUB_APP_PRIVATE_KEY` | acting as the App | The App's private key, PEM. `\n`-escaped newlines are accepted, because most secret stores cannot hold real ones. |
| `GITHUB_APP_PRIVATE_KEY_PATH` | acting as the App | …or a path to read the key from instead. |
| `GITHUB_APP_SLUG` | the install link | The App's slug, so `/auth/install` knows where to send the owner. |

The service refuses to start on a half-configured group (`GITHUB_APP_ID` without a key,
three of the four sign-in variables) rather than running in a mode nobody asked for.

## Storage

Postgres, plain SQL, no ORM and no extension — ADR 0001 wants the database to stay a
connection string, so a managed provider is only a deployment detail.

| Table | Holds |
|---|---|
| `offices` | One row per office: `office_id`, the snapshot as `jsonb`, timestamps. |
| `applied_events` | One row per applied `OfficeEvent` id, which is derived from the GitHub delivery id. Its primary key *is* the dedup mechanism. |
| `installations` | One row per GitHub App installation: which account installed it, whether it is suspended. Not an ACL, and no credential — see [Installing the App](#installing-the-app). |
| `schema_migrations` | Which numbered migration files this database has seen. |

**The database holds no credential at all.** Installation tokens are minted on demand
and cached in memory; user access tokens live in the session store, in memory. There is
nothing at rest to leak, which is also why sessions do not survive a restart.

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
- **A private office needs a GitHub token that can see the repository.** The service asks
  GitHub `GET /repos/{owner}/{repo}` *with that token*: a `200` means the caller can see
  the repository, which is exactly "may read". The answer is cached by (caller, repo) for
  `ACCESS_TTL_MS`, and dropped immediately when an `installation_repositories` or
  `member` delivery says access changed.

| Situation | Answer |
|---|---|
| Public office | `200` |
| Private office, no token and no session | `401 {"error": "authentication_required"}` plus `WWW-Authenticate` (and `signIn: "/auth/github"` when sign-in is configured) |
| Private office, token GitHub rejects | `404 {"error": "unknown_office"}` — deliberately the same answer as an office that does not exist, because whether a private repository exists is itself private. That is how GitHub's own API answers. |
| GitHub unreachable or 5xx | `503 {"error": "access_check_unavailable"}`, and nothing is cached |

### Where the token comes from

Two ways in, **one check**. Both end in the same `RepoAccess.canRead`, so there is
exactly one answer to "may this person read this office", and GitHub gives it.

1. **`Authorization: Bearer <token>`** — a script, `gh auth token`, another service. The
   token *is* the identity: no login is learned, nothing is stored, and the cache key is
   a per-process salted hash of it.

   ```bash
   curl -s -H "authorization: Bearer $(gh auth token)" \
     localhost:8787/office/<owner>/<private-repo> | jq '.actors | length'
   ```

2. **A session cookie**, from "Sign in with GitHub". The browser is sent to
   `GET /auth/github`, comes back through `GET /auth/github/callback`, and leaves with
   an `HttpOnly`, `SameSite=Lax`, `Secure`-when-https cookie holding a signed, opaque
   session id and **nothing else**. The GitHub user access token stays in the session
   store, server-side; the browser never sees it, and neither does any response body.

   ```bash
   # with a cookie jar, the way a browser would
   curl -s -c jar -b jar -L localhost:8787/office/<owner>/<private-repo>
   ```

The header wins when both are present, so a deliberately supplied token is never
silently ignored.

**A session is an identity, not a permission.** Signing in changes only where the token
comes from. There is no permissions table, no role, nothing in Postgres consulted to
decide a read — CLAUDE.md rule 6 and ADR 0001, unchanged by this slice. A signed-in user
GitHub refuses gets the same `404` as an anonymous one.

Session mechanics, briefly: the session id is 256 bits from `randomBytes`; the cookie is
`id.HMAC-SHA256(id, SESSION_SECRET)`, verified in constant time, so a forged or tampered
cookie is simply not a session. `POST /auth/logout` deletes the record server-side, which
makes the old cookie worthless rather than merely forgotten. CSRF on the sign-in itself is
handled by keeping the OAuth `state` in a second short-lived signed cookie and requiring
the two to match; `return_to` is restricted to paths on our own origin, so it cannot be
turned into an open redirect. Sessions live in memory: a restart signs people out, and a
second instance behind a load balancer needs sticky sessions until `SessionStore` gets a
Postgres implementation.

## Installing the App

`GET /auth/install` sends an owner to GitHub's install page. Afterwards GitHub lands them
on the App's **Setup URL**, which should be `PUBLIC_BASE_URL/auth/install/callback`, with
`installation_id` and `setup_action` in the query. Add a `return_to` of your own to that
URL — GitHub keeps it and appends its own parameters — to be redirected into the web app
instead of seeing JSON.

Nothing on that URL is signed, so `installation_id` is caller-supplied and is not taken
on trust: the installation is read back from GitHub as the App
(`GET /app/installations/{id}`, which only answers for installations that really are
ours), and only what GitHub says is stored. The authoritative path is the signed
`installation` delivery — `created`, `suspend`, `unsuspend`, `deleted` — which carries the
whole installation object and needs no call back.

What an installation is *for*: acting as the App. The service signs a short-lived JWT with
the App's private key (`RS256`, `node:crypto`) and exchanges it for an installation token
(`POST /app/installations/{id}/access_tokens`), cached in memory until shortly before it
expires and never written to the database. That is what a periodic resync or a backfill
will use. It is **not** used to authorize a read, and an installation row grants nobody
anything.

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
   (the last two are what invalidate cached read decisions) and Installation (which is
   what records an installation).
6. For sign-in: **Callback URL** = `PUBLIC_BASE_URL/auth/github/callback`, exactly.
   Generate a client secret, and tick "Request user authorization (OAuth) during
   installation" if you want installing and signing in to be one trip.
7. **Setup URL** = `PUBLIC_BASE_URL/auth/install/callback` (optionally with a
   `?return_to=/…` of your own). Leave "Redirect on update" off unless you want the same
   callback after permission changes.
8. Generate a private key and give it to the service as `GITHUB_APP_PRIVATE_KEY` or
   `GITHUB_APP_PRIVATE_KEY_PATH`, with the App id as `GITHUB_APP_ID`.
9. Install the App on a repository, then do something in that repository and read the
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
- `tests/session.test.ts` — cookie signing and tampering, cookie parsing, the cookie
  attributes, session lifetime and destruction, `safeReturnTo` against open redirects.
- `tests/app-auth.test.ts` — the App JWT, verified against a keypair generated in the
  test, and installation tokens: minting, reuse, re-minting before expiry, one request
  for a burst of callers, failures not cached, `\n`-escaped PEMs.
- `tests/sign-in.test.ts` — the whole sign-in over a real server with GitHub faked:
  the redirect out, the callback in, a private office read with nothing but the cookie,
  the token absent from cookie and bodies, header-beats-session, `state` mismatch and
  forged cookies refused, logout destroying the record, `501` when unconfigured.
- `tests/install-flow.test.ts` — the install flow: the setup callback reading the
  installation back from GitHub rather than trusting the query, unknown and malformed
  ids, `installation` deliveries for create/suspend/unsuspend/delete.
- `tests/installations.test.ts` — the payload reader, the in-memory store, and the SQL
  the Postgres store sends.
- `tests/store-postgres.test.ts` — the SQL the store sends, against a recording fake,
  **plus one integration test that is skipped unless `DATABASE_URL` is set**:

```bash
DATABASE_URL=postgres://repofloor:repofloor@localhost:5432/repofloor \
  pnpm --filter @repofloor/api test
```

It runs the real migrations (twice, to prove they are idempotent) and the real stores —
offices, the delivery ledger, the retention cut, installations — against that database,
then cleans up the rows it made. Point it at a throwaway database —
`docker compose up postgres` is one.

## Operations

Backup, the single-command restore, and what the structured logs contain:
[`docs/OPERATIONS.md`](../../docs/OPERATIONS.md).

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
- `OfficeStore.transaction(key, fn)` is optional on purpose: it is a capability, not a
  requirement. A store without one runs the ingest body inline (`withOfficeTransaction`),
  which is right for a process-local map and wrong for anything durable. The key is the
  office id, so one seam gives both halves ingest needs — all-or-nothing writes, and
  per-office serialization that survives a second api process.
- A read decision is cached for a minute, so losing access can take up to a minute to
  take effect unless a `member` or `installation_repositories` delivery arrives first.
  ADR 0001 accepts that; the alternative is a GitHub API call per request.
- Sign-in added a *source of tokens*, not an authorization path. Both routes into
  `GET /office/...` converge on one `RepoAccess.canRead`, which is the only place that
  decides a read — the shape rule 6 asks for.
- That decision now lives in [src/authorize.ts](src/authorize.ts), outside the HTTP
  handler, and `createApp` returns it as `app.authorizeRead(officeId, req)`. It takes an
  `IncomingMessage`, which a WebSocket upgrade request also is, so `apps/realtime` runs
  this check at connect rather than its own. A socket cheaper to open than a `GET` would
  be a hole, not a feature.
- Sessions are in memory, so a restart signs people out and two instances need sticky
  sessions. That buys a database with no credential in it at all. `SessionStore` is the
  seam if the trade ever has to flip; a Postgres implementation would want the user token
  encrypted at rest, which is the work that was not worth doing yet.
- A user access token does not expire by default, so a session holds a usable credential
  for as long as it lives (12h by default). Logging out drops it. Refresh tokens, which
  GitHub offers for Apps with expiring tokens, are the next thing to add here if that
  window is judged too long.
