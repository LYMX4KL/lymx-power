-- =====================================================================
-- Migration 121 — Offer accept-by-token (HR audit P3)
-- =====================================================================
-- 2026-05-27 — completes Helen's HR e2e onboarding chain. Pre-fix, Helen
-- had to manually flip `offers.status='accepted'` in the admin queue when
-- a candidate verbally agreed; the candidate had no self-serve path. New:
-- each "sent" offer carries a one-time accept_token. When Helen clicks
-- "Send to candidate", the page generates a token, stores it on the offer
-- row, and bakes it into the email link. The candidate clicks the link,
-- lands on a public `accept-offer.html?t=<token>` page (no sign-in), sees
-- the offer summary, clicks Accept → fn_offer_accept_by_token fires the
-- existing `tg_offer_accepted_spawn_onboarding` trigger and creates the
-- staff_profiles + onboarding_tasks rows automatically.
--
-- Tables touched: public.offers (adds 3 columns)
-- New functions:
--   - fn_offer_resolve_by_token(p_token uuid) → jsonb (public)
--   - fn_offer_accept_by_token(p_token uuid) → jsonb (public)
-- =====================================================================

begin;

-- ---------- 1. Add token columns to offers --------------------------------
alter table public.offers
    add column if not exists accept_token uuid,
    add column if not exists accept_token_expires_at timestamptz,
    add column if not exists accepted_via_token boolean not null default false,
    add column if not exists accept_token_issued_at timestamptz;

-- Unique index so two offers can't share a token. Partial because most
-- rows will have NULL token (draft, no token issued yet).
create unique index if not exists idx_offers_accept_token
    on public.offers (accept_token)
    where accept_token is not null;

comment on column public.offers.accept_token is
    'One-time-use UUID. Generated when admin clicks "Send to candidate". '
    'Embedded in the magic-link URL the candidate receives. Cleared on accept.';
comment on column public.offers.accept_token_expires_at is
    'When the magic link stops working. Default 14 days from issuance.';
comment on column public.offers.accept_token_issued_at is
    'When the token was generated. Useful for audit / debugging stale links.';
comment on column public.offers.accepted_via_token is
    'TRUE if the candidate accepted via the self-serve magic link (not via '
    'Helen manually flipping the status). For audit.';

-- ---------- 2. fn_offer_resolve_by_token (public) -------------------------
-- Public function — no auth required, gated by token presence + freshness.
-- Returns the offer + applicant info the candidate needs to decide. Does
-- NOT return Helen's notes, internal IDs, or any other admin data.
create or replace function public.fn_offer_resolve_by_token(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_offer record;
    v_app   record;
begin
    if p_token is null then
        return jsonb_build_object('ok', false, 'error', 'no_token');
    end if;

    select * into v_offer
      from public.offers
     where accept_token = p_token
     limit 1;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'token_not_found');
    end if;

    -- Expiry check
    if v_offer.accept_token_expires_at is not null
       and v_offer.accept_token_expires_at < now() then
        return jsonb_build_object('ok', false, 'error', 'token_expired',
            'expired_at', v_offer.accept_token_expires_at);
    end if;

    -- Status check — only sent offers can be accepted via token. Draft/
    -- rescinded/declined/already-accepted should reject the link.
    if v_offer.status <> 'sent' then
        return jsonb_build_object('ok', false, 'error', 'offer_status_not_sent',
            'status', v_offer.status);
    end if;

    -- Pull applicant identifying info
    select first_name, last_name, email into v_app
      from public.job_applications
     where id = v_offer.application_id;

    return jsonb_build_object(
        'ok', true,
        'offer_id', v_offer.id,
        'title', v_offer.title,
        'target_role', v_offer.target_role,
        'employment_type', v_offer.employment_type,
        'work_mode', v_offer.work_mode,
        'pay_type', v_offer.pay_type,
        'pay_period', v_offer.pay_period,
        'pay_rate_cents', v_offer.pay_rate_cents,
        'sign_on_bonus_cents', v_offer.sign_on_bonus_cents,
        'start_date', v_offer.start_date,
        'location', v_offer.location,
        'custom_notes_md', v_offer.custom_notes_md,
        'offer_letter_path', v_offer.offer_letter_path,
        'sent_at', v_offer.sent_at,
        'token_expires_at', v_offer.accept_token_expires_at,
        'candidate_first_name', coalesce(v_app.first_name, ''),
        'candidate_last_name',  coalesce(v_app.last_name,  ''),
        'candidate_email',      coalesce(v_app.email,      '')
    );
end;
$$;

grant execute on function public.fn_offer_resolve_by_token(uuid) to anon, authenticated;

-- ---------- 3. fn_offer_accept_by_token (public) --------------------------
-- Public function — flips status='accepted' which fires the existing
-- tg_offer_accepted_spawn_onboarding trigger (migration 056), which in turn
-- creates the staff_profiles row + seeds onboarding tasks. After accept,
-- the token is cleared so the link can't be reused.
create or replace function public.fn_offer_accept_by_token(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_offer record;
begin
    if p_token is null then
        return jsonb_build_object('ok', false, 'error', 'no_token');
    end if;

    select * into v_offer
      from public.offers
     where accept_token = p_token
     limit 1;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'token_not_found');
    end if;
    if v_offer.accept_token_expires_at is not null
       and v_offer.accept_token_expires_at < now() then
        return jsonb_build_object('ok', false, 'error', 'token_expired');
    end if;
    if v_offer.status <> 'sent' then
        return jsonb_build_object('ok', false, 'error', 'offer_status_not_sent',
            'status', v_offer.status);
    end if;

    -- Flip the status. The BEFORE UPDATE trigger
    -- tg_offer_accepted_spawn_onboarding (migration 056) fires here and
    -- auto-creates staff_profiles + onboarding_tasks + marks job_applications.status='hired'.
    update public.offers
       set status = 'accepted',
           accepted_at = now(),
           accepted_via_token = true,
           accept_token = null,   -- one-time-use: clear after success
           updated_at = now()
     where id = v_offer.id;

    return jsonb_build_object(
        'ok', true,
        'offer_id', v_offer.id,
        'message', 'Offer accepted. Welcome to LYMX! HR will email you next steps within 24 hours.'
    );
end;
$$;

grant execute on function public.fn_offer_accept_by_token(uuid) to anon, authenticated;

-- ---------- 4. RLS: keep token columns hidden from public REST reads ------
-- The offers table's existing RLS (hr_offers_rw from migration 056) already
-- restricts SELECT to HR/admin. Token-based access is via the SECURITY
-- DEFINER functions above, NOT via direct SELECT. So no new RLS needed —
-- but verify the policy below covers UPDATE-by-RPC (it does because
-- SECURITY DEFINER bypasses RLS).

-- ---------- 5. Sanity check: warn if migration 056 trigger is missing ------
do $$
begin
    if not exists (
        select 1 from pg_trigger
         where tgname = 'trg_offer_accepted_spawn_onboarding'
           and tgrelid = 'public.offers'::regclass
    ) then
        raise warning 'Migration 121: trg_offer_accepted_spawn_onboarding does not exist on offers. The accept-via-token flow WILL still flip the status but personnel_profiles + onboarding_tasks will NOT auto-create. Re-apply migration 056 first.';
    end if;
end$$;

commit;
