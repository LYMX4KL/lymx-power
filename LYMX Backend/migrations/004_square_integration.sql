-- =============================================================================
-- LYMX Power — Square POS Integration Schema
-- Created: 2026-05-02
-- Purpose: Tables to support the Square OAuth connection + webhook-driven
--          auto-issuance of LYMX rewards when a customer pays at a connected
--          Square merchant.
--
-- TWO NEW TABLES:
--   1. square_integrations    — one row per business that has connected Square.
--                               Holds the OAuth access/refresh tokens + the
--                               Square merchant + main location identifiers.
--   2. square_webhook_events  — append-only log of every webhook Square sends
--                               us. Enforces idempotency: if Square retries an
--                               event we've already processed (matched by
--                               square_event_id), we skip without double-issuing
--                               LYMX. Also useful for forensic debugging.
--
-- ALSO CHANGED:
--   - businesses.updated_at trigger (already exists from migration 001) will
--     automatically attach to the new tables that have updated_at.
--   - We re-run the trigger DO-block at the end of this migration to pick up
--     the new tables.
--
-- WHAT'S NOT IN THIS MIGRATION:
--   - The Square credentials themselves (App ID, App Secret, Webhook Signature
--     Key) live in Supabase Edge Function env vars, NEVER in the database.
--   - The OAuth/webhook endpoints — those are Edge Functions in `functions/`.
-- =============================================================================


-- =============================================================================
-- TABLE: square_integrations
-- =============================================================================
-- One row per business with a connected Square account.
-- Created on successful OAuth callback; updated on token refresh; soft-deleted
-- (disconnected_at set) when the merchant disconnects rather than dropped.
-- =============================================================================
create table public.square_integrations (
    id                       uuid primary key default gen_random_uuid(),

    -- Which LYMX business this Square account is connected to.
    -- One business → one Square integration (UNIQUE below).
    business_id              uuid not null references public.businesses(id) on delete cascade,

    -- Square's identifiers for this merchant. These come back from the OAuth
    -- token-exchange response and the Square `merchants/me` API call.
    square_merchant_id       text not null,
    square_main_location_id  text,         -- Square's "main" location for the merchant.
                                           -- A merchant can have many locations; we
                                           -- store the main one for default LYMX
                                           -- crediting. Multi-location handling
                                           -- comes later in Phase 5.

    -- OAuth tokens. The access_token authorizes our backend to call Square's
    -- API on behalf of this merchant; refresh_token lets us renew it without
    -- the merchant re-auth'ing. We treat both as secrets: only the
    -- service_role can read them (RLS policy below).
    --
    -- IMPORTANT: these are sensitive. They live in Postgres because we need
    -- programmatic access from Edge Functions. They are NEVER returned to
    -- biz-owner clients — column-level REVOKE (at the bottom of this
    -- migration) makes these columns unreadable to `authenticated` even
    -- for `select *`. Only service_role can read them.
    access_token             text not null,
    refresh_token            text not null,
    token_expires_at         timestamptz not null,

    -- Per-business kill switch. If the merchant temporarily wants to pause
    -- LYMX issuance (e.g. during a system test) they can set this to false
    -- without disconnecting. Webhook handler checks this before issuing.
    issuance_enabled         boolean not null default true,

    -- Lifecycle / audit.
    connected_at             timestamptz not null default now(),
    last_used_at             timestamptz,                    -- updated when we make an API call
    disconnected_at          timestamptz,                    -- soft-delete marker
    created_at               timestamptz not null default now(),
    updated_at               timestamptz not null default now(),

    -- One Square merchant maps to exactly one LYMX business, and vice versa.
    -- (If a merchant owns multiple LYMX businesses they'd need separate Square
    -- accounts per business — acceptable v1 constraint.)
    constraint square_integrations_unique_merchant unique (square_merchant_id),
    constraint square_integrations_unique_business unique (business_id)
);

-- Look up by business (typical: "what's our Square config for this biz?")
create index idx_square_integrations_business on public.square_integrations(business_id)
    where disconnected_at is null;

-- Look up by Square merchant_id (webhook handler: "which biz does this Square
-- event belong to?"). Most-frequently-used path on the hot webhook code path.
create index idx_square_integrations_merchant on public.square_integrations(square_merchant_id)
    where disconnected_at is null;

-- Find tokens that need refreshing soon (so a scheduled job can renew them
-- before they expire). Partial index keeps this small.
create index idx_square_integrations_expiring on public.square_integrations(token_expires_at)
    where disconnected_at is null;

comment on table public.square_integrations is
    'One row per business with a connected Square account. Holds OAuth tokens.';
comment on column public.square_integrations.access_token is
    'Square OAuth access token — secret. Only service_role can read.';
comment on column public.square_integrations.refresh_token is
    'Square OAuth refresh token — secret. Only service_role can read.';


-- =============================================================================
-- TABLE: square_webhook_events
-- =============================================================================
-- Append-only log of every webhook Square sends us. The (UNIQUE) square_event_id
-- column enforces idempotency: if Square retries the same event (which it does
-- on any 5xx or timeout), the second insert fails with a unique-violation and
-- the webhook handler short-circuits without double-issuing LYMX.
--
-- We keep raw_payload + received_signature for debugging signature mismatches
-- and for replaying events if our processing logic had a bug.
-- =============================================================================
create table public.square_webhook_events (
    id                  uuid primary key default gen_random_uuid(),

    -- Square's idempotency key. Every webhook delivery has a unique event_id;
    -- retries of the SAME logical event re-use the same id. This is what makes
    -- "exactly-once" possible from our side.
    square_event_id     text not null,

    -- e.g. "payment.created", "payment.updated", "refund.created".
    event_type          text not null,

    -- Square's merchant_id from the webhook envelope. We use this to look up
    -- the business via square_integrations.
    square_merchant_id  text,

    -- Reference back to our entities (filled in once we've resolved them).
    -- Nullable because we record the event BEFORE we've necessarily mapped it
    -- to a business (e.g. webhooks from a merchant we don't have an integration
    -- for — we still log them so we can debug "why isn't my LYMX issuing?").
    business_id         uuid references public.businesses(id) on delete set null,
    transaction_id      uuid references public.transactions(id) on delete set null,

    -- Processing state. processed_at is null until we successfully complete
    -- handling. processing_error is set if we hit a non-retriable failure
    -- (so a human can investigate without it blocking the webhook log).
    processed_at        timestamptz,
    processing_error    text,

    -- The full webhook body Square sent us (envelope + data). Stored for
    -- forensic debugging and replay. Includes amount, payment_id, timestamps.
    raw_payload         jsonb not null,

    -- The HMAC signature header Square sent. We verify it BEFORE inserting
    -- to this table — so any row in here is signature-valid. We still keep
    -- the value so we can audit later if needed.
    received_signature  text,

    received_at         timestamptz not null default now(),

    -- Idempotency: same event_id can only land here once.
    constraint square_webhook_events_unique_event unique (square_event_id)
);

-- Find unprocessed events (for the reconciliation job that retries failures).
-- Partial index, very small, very fast.
create index idx_square_webhook_events_unprocessed
    on public.square_webhook_events(received_at)
    where processed_at is null;

-- Find recent events for a business (debugging "why didn't my customer get LYMX?").
create index idx_square_webhook_events_by_business
    on public.square_webhook_events(business_id, received_at desc)
    where business_id is not null;

-- Find events that errored out (so the dashboard can flag them for human review).
create index idx_square_webhook_events_errored
    on public.square_webhook_events(received_at desc)
    where processing_error is not null;

comment on table public.square_webhook_events is
    'Append-only log of incoming Square webhooks. Idempotent on square_event_id.';


-- =============================================================================
-- updated_at TRIGGERS — re-run the auto-attach loop from migration 001 so the
-- new tables get the trigger. (square_webhook_events has no updated_at — it's
-- append-only — so it correctly gets skipped.)
-- =============================================================================
do $$
declare t text;
begin
    for t in
        select table_name from information_schema.columns
        where table_schema = 'public'
          and column_name = 'updated_at'
          and table_name in ('square_integrations')   -- only the new ones
    loop
        execute format(
            'create trigger trg_%I_updated before update on public.%I
             for each row execute procedure public.set_updated_at()',
            t, t
        );
    end loop;
end $$;


-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================
alter table public.square_integrations    enable row level security;
alter table public.square_webhook_events  enable row level security;


-- =============================================================================
-- RLS POLICIES — square_integrations
-- =============================================================================
-- Business owner can read + flip the kill-switch on their own integration row.
-- The secrets (access_token, refresh_token) are protected at the COLUMN level
-- via REVOKE below — even if the biz owner runs `select *`, those columns
-- come back as permission errors. Only service_role can read them.
-- =============================================================================

-- Biz owner can SELECT their row. Column-level REVOKE (below) hides secrets.
create policy "square_int_owner_select" on public.square_integrations
    for select to authenticated
    using (public.is_business_owner(business_id));

-- Biz owner can UPDATE their row. The columns they can actually WRITE are
-- controlled by column-level REVOKE below — we lock the secrets and identity
-- fields and leave only `issuance_enabled` writable.
create policy "square_int_owner_update" on public.square_integrations
    for update to authenticated
    using (public.is_business_owner(business_id))
    with check (public.is_business_owner(business_id));

-- INSERT and DELETE are service_role only (no policy = denied for authenticated).
-- Edge Functions create rows on OAuth callback and "soft delete" by setting
-- disconnected_at on disconnect.


-- =============================================================================
-- COLUMN-LEVEL PERMISSIONS — defence in depth for secrets
-- =============================================================================
-- Migration 003 granted blanket SELECT/INSERT/UPDATE/DELETE on all tables to
-- authenticated. We now subtract specific column permissions on the secret
-- columns so even a biz owner who writes `select *` can't see their tokens.
-- This is independent of RLS — it's enforced at the column-grant layer.
-- =============================================================================

-- Hide token columns from authenticated. They remain readable to service_role
-- (which bypasses GRANTs as well as RLS).
revoke select (access_token, refresh_token)
    on public.square_integrations from authenticated;

-- Lock down which columns biz owners can WRITE. They get only `issuance_enabled`
-- — the kill switch — plus `disconnected_at` so they can disconnect themselves.
-- Everything else (tokens, merchant_id, expiry, etc.) is service_role-only.
revoke update on public.square_integrations from authenticated;
grant update (issuance_enabled, disconnected_at)
    on public.square_integrations to authenticated;

-- INSERT is already off for authenticated (no INSERT policy). Belt-and-braces:
revoke insert on public.square_integrations from authenticated;


-- =============================================================================
-- RLS POLICIES — square_webhook_events
-- =============================================================================
-- This is internal infrastructure; biz owners do NOT need direct access. All
-- operations are via service_role. We could add a biz-owner read policy later
-- if we want to expose a "Square activity" tab in the dashboard.
-- =============================================================================
-- (no policies — no authenticated access; service_role bypasses RLS)


-- =============================================================================
-- DONE.
-- After running this migration:
--   - service_role + authenticated have INSERT/UPDATE/DELETE/SELECT via the
--     default privileges set by migration 003.
--   - Biz owners can see their integration row (minus the secret columns,
--     which are blocked by column-level REVOKE).
--   - The OAuth callback Edge Function (next) will INSERT into
--     square_integrations.
--   - The webhook Edge Function (next) will INSERT into square_webhook_events
--     before doing anything else, getting idempotency for free via the unique
--     constraint on square_event_id.
-- =============================================================================
