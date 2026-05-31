-- =============================================================================
-- Migration 164 — Claim-invite email + claim-by-token flow (Build A)
-- =============================================================================
-- When business-event creates a `lymx_pending_claims` row (a person paid a fee
-- at a LYMX business but has no reward wallet yet), we now:
--   1. Email that person an invite to JOIN and CLAIM their reserved LYMX
--      (AFTER INSERT trigger -> pg_net -> send-claim-invite EF, mirrors mig 161).
--   2. Let them resolve the offer publicly by token on the signup page
--      (fn_resolve_pending_claim) and, once signed in with the matching email,
--      claim it (fn_claim_pending_by_token) — which issues the held LYMX through
--      the CANONICAL lymx_issuances ledger (same path as business-event 7b).
--
-- Reward belongs to the person who paid the fee (identified by customer_email,
-- = the business's customer_ref). Claiming requires the signed-in user's email
-- to match the claim's customer_email — one wallet per person, no token sharing.
--
-- Pieces:
--   * lymx_pending_claims.invite_emailed_at / invite_email_status  — send-once
--   * email_templates row 'customer_claim_invite'                  — editable copy
--   * fn_send_claim_invite_on_insert()  trigger -> send-claim-invite EF
--   * fn_resolve_pending_claim(token)   -> jsonb (anon: show the offer)
--   * fn_claim_pending_by_token(token)  -> jsonb (auth: issue + mark claimed)
-- =============================================================================

-- ---------- 1. idempotency columns on the holding table ----------------------
alter table public.lymx_pending_claims
    add column if not exists invite_emailed_at  timestamptz,
    add column if not exists invite_email_status text;

-- ---------- 2. editable claim-invite email template --------------------------
-- Placeholders filled by send-claim-invite EF: {{lymx_amount}}, {{dollar_value}},
-- {{business_name}}, {{claim_url}}, {{expires_date}}, {{browse_url}}.
insert into public.email_templates (key, subject, body) values
('customer_claim_invite',
 'You have {{lymx_amount}} LYMX waiting (~${{dollar_value}}) — claim it',
$claim_tpl$Hi there,

Good news: {{business_name}} just rewarded you with {{lymx_amount}} LYMX — about ${{dollar_value}} in spending power — for a fee you already paid. We are holding it for you, but it needs a free LYMX account to land in.

LYMX is a rewards network: the LYMX you earn at one business can be spent at any business in the network. There is nothing to buy and no fee to join — you simply claim what you already earned and start spending it.

CLAIM YOUR {{lymx_amount}} LYMX:
{{claim_url}}

It takes about a minute — create your free account with this same email address and your {{lymx_amount}} LYMX drops straight into your wallet.

Heads up: your reward is reserved until {{expires_date}}. After that the hold is released, so claim it before then.

See where you can spend LYMX across the network:
{{browse_url}}

Welcome to LYMX,
The LYMX Team$claim_tpl$)
on conflict (key) do update
    set subject = excluded.subject, body = excluded.body, updated_at = now();

-- ---------- 3. AFTER INSERT trigger -> send-claim-invite EF -------------------
-- Fires for every new pending claim. The EF is send-once (invite_emailed_at) and
-- only emails when a customer_email is present, so this is safe to fire openly.
create or replace function public.fn_send_claim_invite_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public, net, pg_temp
as $fn$
begin
    if (new.status = 'pending' and new.customer_email is not null and new.invite_emailed_at is null) then
        perform net.http_post(
            url     := 'https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/send-claim-invite',
            body    := jsonb_build_object('claim_id', new.id),
            headers := '{"Content-Type":"application/json"}'::jsonb
        );
    end if;
    return new;
end;
$fn$;

drop trigger if exists trg_send_claim_invite on public.lymx_pending_claims;
create trigger trg_send_claim_invite
    after insert on public.lymx_pending_claims
    for each row execute function public.fn_send_claim_invite_on_insert();

-- ---------- 4. public resolve (show the offer on the signup page) -------------
-- Token IS the secret (random hex). Returns the offer summary + a MASKED email so
-- the page can say "reserved for j***@x.com" without leaking the full address.
create or replace function public.fn_resolve_pending_claim(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
    c            public.lymx_pending_claims%rowtype;
    biz_name     text;
    masked       text;
begin
    if p_token is null or length(p_token) < 8 then
        return jsonb_build_object('ok', false, 'error', 'no_token');
    end if;

    select * into c from public.lymx_pending_claims where invite_token = p_token;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'not_found');
    end if;

    select coalesce(display_name, legal_name, 'a LYMX business') into biz_name
      from public.businesses where id = c.business_id;

    if c.customer_email is not null and position('@' in c.customer_email) > 1 then
        masked := left(c.customer_email, 1) || '***@' || split_part(c.customer_email, '@', 2);
    else
        masked := null;
    end if;

    return jsonb_build_object(
        'ok', true,
        'status', c.status,
        'expired', (c.expires_at is not null and c.expires_at < now()),
        'lymx_amount', c.lymx_amount,
        'dollar_value', round(c.lymx_amount::numeric / 100.0, 2),
        'business_name', biz_name,
        'expires_at', c.expires_at,
        'reserved_for', masked
    );
end;
$fn$;

-- ---------- 5. claim (signed-in, email-matched) -> issue + mark claimed -------
-- Issues the held LYMX through the canonical ledger (mirrors business-event 7b)
-- with idempotency_key = the claim's external_ref, so it can never double-issue.
create or replace function public.fn_claim_pending_by_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
    c          public.lymx_pending_claims%rowtype;
    v_uid      uuid := auth.uid();
    v_email    text := lower(coalesce(auth.jwt() ->> 'email', ''));
    biz_name   text;
    v_iss_id   uuid;
begin
    if v_uid is null then
        return jsonb_build_object('ok', false, 'error', 'not_signed_in');
    end if;
    if p_token is null or length(p_token) < 8 then
        return jsonb_build_object('ok', false, 'error', 'no_token');
    end if;

    select * into c from public.lymx_pending_claims where invite_token = p_token for update;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'not_found');
    end if;

    if c.status = 'claimed' then
        return jsonb_build_object('ok', true, 'already_claimed', true, 'lymx_amount', c.lymx_amount);
    end if;
    if c.status <> 'pending' then
        return jsonb_build_object('ok', false, 'error', 'status_' || c.status);
    end if;
    if c.expires_at is not null and c.expires_at < now() then
        return jsonb_build_object('ok', false, 'error', 'expired', 'expires_at', c.expires_at);
    end if;

    -- Reward belongs to the person who paid the fee. Require the signed-in user's
    -- email to match the claim's customer_email (case-insensitive).
    if c.customer_email is null or lower(c.customer_email) <> v_email then
        return jsonb_build_object(
            'ok', false, 'error', 'email_mismatch',
            'reserved_for', case when c.customer_email is not null
                then left(c.customer_email,1) || '***@' || split_part(c.customer_email,'@',2) else null end);
    end if;

    -- Issue through the canonical ledger. Unique (business_id, idempotency_key)
    -- guarantees one issuance per fee; re-read on conflict for safe retries.
    begin
        insert into public.lymx_issuances (
            recipient_user_id, business_id, amount_lymx, reason,
            transaction_amount_cents, transaction_method, verified, admin_status, idempotency_key
        ) values (
            v_uid, c.business_id, c.lymx_amount, 'business_event',
            c.amount_usd_cents, 'webhook', true, 'auto', c.external_ref
        )
        returning id into v_iss_id;
    exception when unique_violation then
        select id into v_iss_id from public.lymx_issuances
         where business_id = c.business_id and idempotency_key = c.external_ref
         limit 1;
    end;

    update public.lymx_pending_claims
       set status = 'claimed', claimed_at = now(), claimed_user_id = v_uid, issuance_id = v_iss_id
     where id = c.id;

    select coalesce(display_name, legal_name, 'a LYMX business') into biz_name
      from public.businesses where id = c.business_id;

    return jsonb_build_object('ok', true, 'lymx_amount', c.lymx_amount, 'business_name', biz_name);
end;
$fn$;

-- ---------- 6. grants --------------------------------------------------------
grant execute on function public.fn_resolve_pending_claim(text) to anon, authenticated;
grant execute on function public.fn_claim_pending_by_token(text) to authenticated;

notify pgrst, 'reload schema';
