-- Full mode storage: one row per office plus the applied-event ledger that keeps
-- webhook re-deliveries idempotent across restarts.
--
-- Plain Postgres only (ADR 0001): no extension, no vendor SQL, so the database stays
-- a connection string.

create table if not exists offices (
  office_id  text primary key,
  snapshot   jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per OfficeEvent id. Event ids are derived from the GitHub delivery id, so the
-- primary key is what makes `markDelivered` a durable dedup check.
create table if not exists applied_events (
  event_id   text primary key,
  applied_at timestamptz not null default now()
);

-- Supports the retention cut: ids older than the retention window are deleted, because
-- GitHub never re-delivers a week-old webhook and the ledger would grow forever.
create index if not exists applied_events_applied_at_idx on applied_events (applied_at);
