-- =============================================================================
-- LYMX Power — Partner Email Provisioning Schema
-- Created: 2026-05-03
-- Purpose: One table to track every LYMX partner's auto-provisioned company
--          email (firstname.lastname@getlymx.com) and the per-agent SMTP
--          credentials that let them REPLY from that address via Gmail's
--          "Send mail as" feature.
--
-- ARCHITECTURE: see Gemini/shared accross projects/COMPANY-EMAIL-ARCHITECTURE.md
--   - Cloudflare Email Routing handles inbound (free)
--   - Amazon SES handles outbound when partner replies via Gmail SMTP relay
--   - This table is the source of truth for provisioning state.
--
-- LIFECYCLE:
--   pending     — row created, nothing actually provisioned yet (Edge Function
--                 just inserted but hasn't called Cloudflare/SES APIs).
--   provisioning— in-flight: we're calling external APIs. If something fails
--                 mid-flight, last_error is set and we can retry.
--   active      — Cloudflare route exists, SES identity verified, partner has
--                 a working two-way email. Their onboarding email has been
--                 sent (with the SMTP credentials).
--   suspended   — partner offboarded. Cloudflare route DELETED. SES identity
--                 revoked. Inbound bounces; outbound rejects. Row kept for
--                 audit, never DELETEd.
--
-- WHAT'S NOT IN THIS MIGRATION:
--   - Cloudflare API token, AWS SES keys — those live in Supabase Edge
--     Function env vars (CF_API_TOKEN_LYMX, SES_AWS_ACCESS_KEY_LYMX, etc.)
--   - The provisioning Edge Function itself — that comes next, in
--     functions/partner-provision-email/.
-- =============================================================================


-- =============================================================================
-- TABLE: partner_emails
-- =============================================================================
-- One row per partner. Partner can have at most one provisioned email at a
-- time (UNIQUE on partner_id). On reconnect after suspension we UPDATE the
-- existing row rather than INSERT a new one (preserves audit history).
-- =============================================================================
create table public.partner_emails (
    id                       uuid primary key default gen_random_uuid(),

    -- Which LYMX partner this email belongs to.
    partner_id               uuid not null references public.partners(id) on delete cascade,

    -- The generated address.
    -- local_part is whatever we chose (typically firstname.lastname, with
    -- .2/.3 suffix on collision). full_email is local_part + '@getlymx.com'.
    -- We store both so we can query either way without a string concat.
    local_part               text not null,                 -- 'maya.chen'
    full_email               text not null,                 -- 'maya.chen@getlymx.com'

    -- Snapshot of the partner's contact_email at provision time. We don't
    -- reference partners.contact_email directly because that may change later
    -- (partner updates their personal email) and we need to know what we
    -- ACTUALLY configured Cloudflare to forward to. If their contact email
    -- changes, the provisioning Edge Function updates this column and the
    -- Cloudflare route in lockstep.
    forward_to               text not null,

    -- Snapshot of partner.legal_name (or display_name) at provision time.
    -- Used in the onboarding email's Gmail "Send mail as" Name field, and
    -- as the From-name when the partner sends through SES. Snapshotted so
    -- a name change in `partners` doesn't silently break their existing
    -- email setup.
    display_name             text not null,

    -- Lifecycle. See header comment for state machine.
    status                   text not null default 'pending',

    -- IDs from external services so we can DELETE / revoke on offboarding.
    cloudflare_route_id      text,                          -- DELETE this on suspend
    ses_identity_verified    boolean not null default false,

    -- Per-agent SMTP credentials from AWS SES.
    -- SECRET — column-level REVOKE below blocks `authenticated` from reading
    -- these. Only service_role (Edge Functions) can. The partner sees them
    -- ONCE in their onboarding email; from there they live in their Gmail
    -- "Send mail as" config — we don't need them to look the values up
    -- again, and we don't expose them via any user-facing API.
    --
    -- (Postgres encrypts at rest at the disk level via Supabase. For a
    -- paranoid v2 we can layer pgcrypto + KMS. Acceptable for v1.)
    smtp_username            text,
    smtp_password            text,

    -- Audit timestamps.
    provisioned_at           timestamptz,                   -- moved to 'active' at this time
    onboarding_email_sent_at timestamptz,                   -- when we Resend'd the welcome email
    partner_acknowledged_at  timestamptz,                   -- partner clicked the "I've set it up" link
    suspended_at             timestamptz,                   -- soft-delete marker

    -- Most recent provisioning error (cleared on next success).
    -- e.g. "Cloudflare API: 429 rate limit", "SES CreateEmailIdentity failed: ..."
    last_error               text,

    created_at               timestamptz not null default now(),
    updated_at               timestamptz not null default now(),

    -- One LYMX email per partner.
    constraint partner_emails_unique_partner unique (partner_id),
    constraint partner_emails_unique_email   unique (full_email)
);

-- Hot-path lookup: by partner (dashboard "what's my LYMX email?")
create index idx_partner_emails_partner on public.partner_emails(partner_id)
    where suspended_at is null;

-- Hot-path lookup: by full_email (incoming hooks/jobs that reference an address)
create index idx_partner_emails_full on public.partner_emails(full_email)
    where suspended_at is null;

-- Reconciliation job: find pending/provisioning rows that need a retry.
-- Partial index keeps this small even with many partners.
create index idx_partner_emails_unfinished on public.partner_emails(updated_at)
    where status in ('pending', 'provisioning');

comment on table public.partner_emails is
    'Per-partner provisioned @getlymx.com email + SMTP credentials. Lifecycle pending → provisioning → active → suspended.';
comment on column public.partner_emails.smtp_username is
    'AWS SES SMTP username — secret. Column-level REVOKE below.';
comment on column public.partner_emails.smtp_password is
    'AWS SES SMTP password — secret. Column-level REVOKE below.';


-- =============================================================================
-- updated_at TRIGGER (re-run the auto-attach loop from migration 001)
-- =============================================================================
do $$
declare t text;
begin
    for t in
        select table_name from information_schema.columns
        where table_schema = 'public'
          and column_name = 'updated_at'
          and table_name in ('partner_emails')
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
alter table public.partner_emails enable row level security;


-- =============================================================================
-- RLS POLICIES — partner_emails
-- =============================================================================
-- Every partner can read THEIR OWN row (so the dashboard can show "your LYMX
-- email is maya.chen@getlymx.com"). The smtp_* columns are then blocked at
-- the COLUMN level via REVOKE below — a partner running `select *` gets a
-- permission error on those two columns specifically.
--
-- Partners can UPDATE only `partner_acknowledged_at` (to mark "I've set up
-- my Gmail Send-mail-as"). The column-level grant below restricts UPDATE to
-- that one column.
--
-- INSERT and DELETE are service_role only (no policy = denied for authenticated).
-- The provisioning Edge Function creates rows; offboarding flips status to
-- 'suspended' rather than DELETEing.
-- =============================================================================

-- Helper: is the current authenticated user this partner?
-- We could use public.current_partner_id() from migration 002, but that returns
-- NULL for non-partners. Inline check is clearer here.
create policy "partner_emails_owner_select" on public.partner_emails
    for select to authenticated
    using (
        partner_id in (
            select id from public.partners where user_id = auth.uid()
        )
    );

create policy "partner_emails_owner_update" on public.partner_emails
    for update to authenticated
    using (
        partner_id in (
            select id from public.partners where user_id = auth.uid()
        )
    )
    with check (
        partner_id in (
            select id from public.partners where user_id = auth.uid()
        )
    );


-- =============================================================================
-- COLUMN-LEVEL PERMISSIONS — defence in depth for SMTP secrets
-- =============================================================================
-- Same pattern as migration 004 (Square integrations).
-- Migration 003 granted blanket SELECT/INSERT/UPDATE/DELETE on all tables to
-- authenticated. We subtract specific column permissions on the secret
-- columns so even a partner who writes `select *` can't see their SMTP creds
-- (they got them once in their onboarding email; that's the only time they
-- need to see them).
-- =============================================================================

-- Hide SMTP credentials from authenticated. Service_role bypasses GRANTs.
revoke select (smtp_username, smtp_password)
    on public.partner_emails from authenticated;

-- Lock down which columns partners can WRITE.
-- They can only mark themselves as "I've set up Gmail" — nothing else.
-- Everything else (status changes, token rotation, suspension) is service_role.
revoke update on public.partner_emails from authenticated;
grant update (partner_acknowledged_at)
    on public.partner_emails to authenticated;

-- INSERT and DELETE are off for authenticated (no policies). Belt-and-braces:
revoke insert on public.partner_emails from authenticated;
revoke delete on public.partner_emails from authenticated;


-- =============================================================================
-- DONE.
-- After running this migration:
--   - service_role has full INSERT/UPDATE/DELETE/SELECT (default privileges
--     from migration 003).
--   - Partners can SELECT their own row (minus smtp_* columns) and UPDATE
--     only `partner_acknowledged_at`.
--   - The provisioning Edge Function (next) will INSERT a row, then call
--     Cloudflare API + SES API, then UPDATE the row with route_id + SMTP
--     creds + status='active', then send the onboarding email.
-- =============================================================================
