-- Where a backfill got to, so it can be resumed (ADR 0003, H4).
--
-- A repository with years of history cannot be walked inside one request, one process
-- lifetime, or one rate-limit budget. Each step does a bounded amount of work and
-- writes where it stopped; this is where.

create table if not exists backfill_state (
  office_id  text primary key,
  -- The stepper's own cursor, opaque here on purpose: what it takes to resume a walk
  -- is the walker's business, and pinning its shape in a column would mean a
  -- migration every time the traversal changes.
  cursor     jsonb not null,
  done       boolean not null default false,
  -- Requests spent in total, so a repository that is costing more than it is worth is
  -- visible rather than merely slow.
  spent      integer not null default 0,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- "Give me something still to do" is the only query that picks a row rather than
-- naming one.
create index if not exists backfill_state_done_idx on backfill_state (done, updated_at);
