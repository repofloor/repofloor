-- The event log behind every office: what happened, in order, kept (ADR 0003).
--
-- Deliberately *not* `applied_events`. That table is a dedup ledger of ids with a
-- weekly retention cut, because GitHub never re-delivers a week-old webhook and it
-- would otherwise grow without bound. Folding history into it would force a choice
-- between keeping ids forever and losing history every week. Two tables, two jobs.

create table if not exists office_events (
  -- The same id dedup uses, so an event cannot be stored twice however it arrives:
  -- a webhook, a resync, or a backfill reaching the same commit again.
  event_id  text primary key,
  office_id text not null,
  -- From the event itself, never the clock. The reducer takes its time from `at`
  -- (rule 2), and a replay sorted by arrival would land on states that never existed.
  at        timestamptz not null,
  body      jsonb not null
);

-- Every read is "this office, this span, in order", which is exactly this index.
create index if not exists office_events_office_at_idx on office_events (office_id, at);
