-- =============================================================================
-- Migration 041 — Google OAuth tokens (for Calendar sync)
-- =============================================================================
-- One row per (user_id, provider). We only need `google` today but the table is
-- generic so we can add Microsoft/Apple later.
--
-- Token lifecycle:
--   * access_token expires in ~1 hour; refresh_token is long-lived
--   * Each call to google-busy or book-call (when pushing an event) checks
--     expires_at and refreshes if needed via the refresh_token
-- =============================================================================

create table if not exists public.oauth_tokens (
    id              uuid primary key default uuid_generate_v4(),
    user_id         uuid not null references auth.users(id) on delete cascade,
    provider        text not null,                            -- 'google', future: 'microsoft', etc.

    -- Tokens
    access_token    text not null,
    refresh_token   text,
    token_type      text default 'Bearer',
    scope           text,                                      -- space-separated scopes
    expires_at      timestamptz,                               -- when access_token expires

    -- Provider-specific account identity
    provider_account_id text,                                  -- e.g. Google's "sub" claim
    provider_email      text,                                  -- email of the connected Google account

    -- Per-feature toggles (so the user can disable sync without disconnecting)
    push_bookings   boolean not null default true,             -- create events in their calendar
    pull_busy       boolean not null default true,             -- read busy times to filter slots

    -- Audit
    connected_at    timestamptz not null default now(),
    last_refreshed_at timestamptz,
    last_used_at    timestamptz,

    unique (user_id, provider)
);

create index if not exists idx_oauth_tokens_user on public.oauth_tokens(user_id);
create index if not exists idx_oauth_tokens_provider on public.oauth_tokens(provider);


-- updated_at trigger
create or replace function public.set_oauth_tokens_updated()
returns trigger language plpgsql as $$
begin
    return new;
end;
$$;


-- ===== RLS ==================================================================
alter table public.oauth_tokens enable row level security;

-- Admin can see all
drop policy if exists oauth_admin_all on public.oauth_tokens;
create policy oauth_admin_all on public.oauth_tokens
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- Each user can see/manage their own tokens
drop policy if exists oauth_self on public.oauth_tokens;
create policy oauth_self on public.oauth_tokens
    for all to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid());

-- Insert/Update goes through service-role EFs primarily, but allow user upsert
-- of toggle columns so the UI can flip push_bookings / pull_busy without an EF.
grant select, update on public.oauth_tokens to authenticated;


-- ===== Verify ===============================================================
select 'migration 041 applied' as status,
       (select count(*) from information_schema.tables where table_schema='public' and table_name='oauth_tokens') as table_present;
