-- GitHub App installations: which accounts have installed the App, so the service can
-- act as the App for background work (minting an installation token to resync an
-- office, for instance) without a human in the loop.
--
-- This table is **not** an ACL. CLAUDE.md rule 6 and ADR 0001: GitHub is the only ACL,
-- and `GET /office/...` is still authorized by asking GitHub with the caller's own
-- token. Knowing that an App is installed on an account says nothing about who may
-- read it.
--
-- No tokens live here, by design. Installation tokens expire in an hour and are minted
-- from the App's private key on demand (see src/app-auth.ts); user access tokens live
-- in the session store, in memory. The database holds no credential at all.
--
-- Plain Postgres only (ADR 0001): no extension, no vendor SQL.

create table if not exists installations (
  installation_id      bigint primary key,
  account_login        text not null,
  account_id           bigint,
  -- "User" or "Organization", as GitHub reports it.
  account_type         text,
  -- "all" or "selected": whether the App was granted every repository of the account.
  repository_selection text,
  suspended            boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Lookups go by account login ("has this org installed the App?"), case-insensitively,
-- because GitHub logins are case-insensitive.
create index if not exists installations_account_login_idx on installations (lower(account_login));
