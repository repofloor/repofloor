# ADR 0003 — History and replay: watching a repository's whole life

- **Status:** accepted
- **Date:** 2026-10-16
- **Deciders:** @aliosmanmho (sole maintainer)
- **Builds on:** [ADR 0001](0001-full-mode-stack.md) (Postgres, and the database stays
  replaceable) and [ADR 0002](0002-realtime-transport.md) (the live path this is the
  past tense of)

## Context

The office shows now. The ask is to show *then*: today, a week, a month, an arbitrary
date range, and — the one that shapes everything — a repository replayed from its first
commit to this morning, as an animation you can scrub.

The architecture already gives away most of the replay. The reducer is pure and takes
its time from `event.at` rather than the clock (rule 2), and `replay(initial, events,
nowIso)` has existed since Phase 0. Feeding events in time order at an adjustable rate
*is* the feature. That is rule 2 paying for itself three phases later.

What does not exist is the events. Nothing in the system keeps any history at all:

- **Lite** publishes one snapshot. `collect()` builds `OfficeEvent[]`, replays them into
  an `OfficeState`, and throws the events away.
- **Full** stores the current snapshot per office. `applied_events` holds event *ids*
  and nothing else — it is a dedup ledger, deliberately, and it is cut back weekly.

So this is a data problem wearing a UI problem's clothes.

## Decision 1 — The boundary: replay is office-level

**The replay shows an office, not a person.** No per-person filter, no highlighting one
contributor through time, no aggregation by author. The API does not take an actor
parameter and the player does not offer one.

This is not squeamishness, it is the project's stated identity. Rule 6 says: *not a
surveillance tool — show what, not how long.* We keep no durations, and a single
snapshot genuinely cannot answer "how long was Ali at his desk". A scrubbable year of
one person's activity can, by inspection, whether or not we store a number. The rule
exists to prevent exactly the artifact that feature would produce.

Office-level replay keeps what makes it worth building — a repository's life as
something you can watch — and drops only the part that turns it into a performance
review. If that line ever moves it is a deliberate decision with its own ADR and an
edit to rule 6, because the rule as written would no longer be true.

## Decision 2 — History lives in Full mode; Lite gets a bounded version

**Full mode** stores events in Postgres and serves ranges. It already has a database, an
App identity that can mint installation tokens, and a resync that knows how to rebuild
an office from the REST API. Everything the backfill needs is already standing.

**Lite** publishes the events it already collected, next to the snapshot it already
publishes. That is a window — 48 hours by default, 72 for us — and inside it the page
can replay any sub-range. A day/week toggle falls out for the cost of writing a file we
currently discard.

Lite does **not** get "from the first commit". Doing it there would mean the Action
paging years of GitHub API on every run into a static file the browser then downloads
whole: slow, large, and straight into rate limits, for a result that is stale an hour
later. That is the wrong shape, and saying so is more useful than half-building it.

## Decision 3 — Prove the player before building the backfill

The expensive, uncertain part is the backfill: hundreds of paginated requests per
repository, rate limits, resumability, and a schema to hold the result. The cheap,
certain part is the player, because `replay` already exists.

So the order is deliberately backwards from the ambition:

1. **Lite publishes its events**, and the page gains a player over them. ~72 hours of
   real data, no backend, no migration. If the player is wrong, it is wrong now and
   cheaply.
2. **Full stores events on ingest** — a table beside `applied_events`, written in the
   same transaction the snapshot is.
3. **Backfill as the App**: an unbounded, resumable historical collection.
4. **Range API and the full player**: `from`/`to` over everything.

Three recent bugs in this project were all found by running something rather than
reasoning about it, each of them after the surrounding work was already built. Putting
the known-cheap half first means the half we understand least arrives into something
already proven, instead of both being new at once.

## Consequences

- `collect()` needs an unbounded mode. Today its look-back is a window in hours; a
  backfill wants "everything, resumably", which is a different traversal and probably a
  different function beside it rather than another option on the same one.
- A new table holds event bodies. `applied_events` stays exactly as it is — it is a
  dedup ledger with a retention cut, and conflating the two would mean either keeping
  ids forever or losing history weekly.
- Storage is modest and worth stating: an event is a few hundred bytes of JSON, so a
  repository with ten thousand commits and a couple of thousand pull requests lands
  around a few megabytes. Postgres does not notice. A static file would.
- The published Lite snapshot grows by its events. Bounded by the look-back window, so
  tens of kilobytes, and a page that ignores the file is unaffected.
- Replay is a read of stored events through the same pure reducer the live path uses.
  There is no second implementation of what an event means, and there must not be
  (rule 1).
