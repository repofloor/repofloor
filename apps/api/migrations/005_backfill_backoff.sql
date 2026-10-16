-- Backing off an office that keeps failing (ADR 0003).
--
-- 004 gave a failing step a way to yield its turn, which stopped one broken repository
-- starving the queue. It did not stop the waste: a repository that was deleted,
-- renamed or made private came back every interval for ever, spending a request each
-- time to learn the same thing.
--
-- So a failing office now waits, for longer each time, and is eventually parked.
-- Parked is deliberately not `done`: its history really is unfinished, and recording
-- it as complete is how a missing repository once came to look fully walked.

alter table backfill_state add column if not exists failures integer not null default 0;
-- Null means "not backing off", which is also what a step that got through leaves.
alter table backfill_state add column if not exists retry_after timestamptz;
-- Set means given up on, and says why — a park nobody can see is indistinguishable
-- from a backfill that silently never ran.
alter table backfill_state add column if not exists parked_reason text;

-- "Give me something still to do" now means: unfinished, not parked, and not waiting.
-- Partial, because the rows it excludes are exactly the ones that never match.
drop index if exists backfill_state_done_idx;
create index if not exists backfill_state_ready_idx
    on backfill_state (updated_at)
 where done = false and parked_reason is null;
