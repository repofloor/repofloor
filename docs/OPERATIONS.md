# Operations (Full mode)

Lite mode needs none of this: it is a GitHub Action and a static page, with no server
and no database. This file is for running `apps/api` and the services that will join it.

[ADR 0001](adr/0001-full-mode-stack.md) chose self-hosted services on plain Postgres
with eyes open: "operations are ours". It named three things that had to exist for that
to be an honest choice — a managed database, **a documented single-command restore**,
and **structured logs** in place of a dashboard. Both of ours are below.

## Backup and restore

The database holds exactly two kinds of thing, and neither is a credential:

- `offices` — the current snapshot per office, as `jsonb`
- `applied_events` — the ledger of event ids already applied (dedup), cut back hourly
- `installations` — which accounts installed the App

Sessions, GitHub tokens and installation tokens are deliberately **not** stored: they
live in memory and are gone on restart. So a restore brings back offices, not people's
sign-ins, and that is the intended trade (see ADR 0001 and `apps/api/README.md`).

### Back up

One command, nightly, from anywhere that can reach the database:

```bash
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > repofloor-$(date +%F).dump
```

`--format=custom` is what makes the restore below a single command; a plain-SQL dump
would need `psql` and would not restore in parallel.

### Restore

Into an empty database — the promised single command:

```bash
pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$DATABASE_URL" repofloor-2026-10-15.dump
```

Then start `apps/api`. It applies any migrations the dump predates at startup, so a
dump from an older schema needs no extra step.

Worth knowing when you do it for real:

- **Stop the api first**, or a delivery arriving mid-restore writes a row the restore
  then drops. GitHub retries failed deliveries, so a short outage costs nothing.
- **A restore is not a disaster plan by itself.** Snapshots are derived state: every
  office can also be rebuilt from the GitHub REST API (this is what phase 2D's resync
  does, and what the Lite action already does from scratch). Losing the database costs
  history, not the office.
- Verify with `psql "$DATABASE_URL" -c 'select count(*) from offices'` before trusting it.

### Local practice run

```bash
WEBHOOK_SECRET=dev-secret docker compose up --build -d
docker compose exec -T postgres pg_dump --format=custom --no-owner -U repofloor repofloor > /tmp/repofloor.dump
docker compose exec -T postgres pg_restore --clean --if-exists --no-owner -U repofloor -d repofloor < /tmp/repofloor.dump
```

> Not yet run end to end — `docker compose up --build` is still owed on a machine with a
> Docker daemon (roadmap 2D-1). Treat the block above as the intended shape until then.

## Logs

One JSON object per line on stdout, which is what a container runtime, `docker compose
logs` and every log shipper already expect. No dependency and no formatter: see
`apps/api/src/log.ts`.

```json
{"ts":"2026-10-15T09:12:44.901Z","level":"info","msg":"request","service":"api","method":"GET","path":"/office/repofloor/repofloor","status":200,"durationMs":7}
```

Every line carries `ts`, `level`, `msg` and `service`. Beyond that:

| msg | fields | when |
| --- | --- | --- |
| `listening` | `url`, `store`, `signIn`, `appIdentity` | at startup — the whole shape of the process in one line |
| `request` | `method`, `path`, `status`, `durationMs` | every HTTP request, on response |
| `unhandled request error` | `method`, `path`, `error`, `stack` | a route threw; the caller got a 500 |
| `migrations applied` | `migrations` | startup applied schema files |
| `pruned applied event ids` | `pruned` | the hourly retention cut removed rows |
| `installation not recorded` | `installationId`, `error` | an `installation` delivery could not be stored |

`LOG_LEVEL` is `debug | info | warn | error | silent`, default `info`.

**What is never logged**: tokens, cookies, session ids, signatures, and query strings.
The last one is not fussiness — `/auth/github/callback?code=…` carries a live OAuth
code, so the request log records `path` only, by construction rather than by redaction.

Useful one-liners:

```bash
# slowest requests in the last run
docker compose logs api --no-log-prefix | jq -r 'select(.msg=="request") | [.durationMs, .method, .path] | @tsv' | sort -rn | head

# everything about one office
docker compose logs api --no-log-prefix | jq 'select(.officeId=="repofloor/repofloor")'

# errors only
docker compose logs api --no-log-prefix | jq 'select(.level=="error")'
```

## apps/realtime

Same log format, `service: "realtime"`. It holds no credential of its own: every socket
is authorized by asking `apps/api` with the caller's own credentials forwarded
(ADR 0002), so there is nothing in this process to compromise into a wider read.

| msg | fields | when |
| --- | --- | --- |
| `listening` | `url`, `apiUrl`, `socketPath` | startup |
| `listening for office notifications` | `channel` | the `LISTEN` connection is in place |
| `socket open` / `socket closed` | `officeId`, `viewer`, `clients` | a client joined or left an office |
| `socket refused` | `officeId`, `reason`, `status` | the upgrade was rejected before a socket existed |
| `listen connection lost` | `error` | the dedicated connection dropped; a reconnect follows |
| `listener reconnected; resyncing every live office` | — | a gap nothing can measure, so everyone gets a snapshot |

Two reachability requirements, and both failures are refusals rather than degraded
service: Postgres (to listen, and to read snapshots) and the api (to authorize).

```bash
docker compose logs realtime --no-log-prefix | jq 'select(.msg=="socket refused")'
```

`GET /healthz` on 8788 answers `{ok, offices}` — `offices` being the number of channels
with at least one client.

## Health and listing

- `GET /healthz` — liveness, plus the protocol version and whether sign-in is configured.
- `GET /offices` — every office the caller may see. Public ones are listed for anyone;
  private ones only for a caller GitHub vouches for, so the listing can never leak the
  *name* of a private repository. `partial: true` means at least one office was left out
  because GitHub could not be asked — the listing is shorter than the truth.
