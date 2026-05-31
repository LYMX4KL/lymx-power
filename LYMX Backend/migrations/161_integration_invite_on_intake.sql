-- =============================================================================
-- Migration 161 — auto-send the integration-invite letter when intake completes
-- =============================================================================
-- When a business finishes its intake form (businesses.intake_completed_at goes
-- null -> set), LYMX automatically emails the business's technical contact the
-- "build one read endpoint" integration letter. Marketing/onboarders can also
-- fire it manually from the portal. The letter text is an EDITABLE template
-- (operator-configurable rule) — marketing changes the wording without a deploy.
--
-- Pieces:
--   * businesses.tech_contact_email          — where the letter goes (intake field)
--   * email_templates                        — editable template store
--   * business_integration_invite_log        — send-once idempotency
--   * trigger -> pg_net -> send-business-integration-invite EF (verify_jwt off)
-- =============================================================================

-- 1. recipient for the integration letter (captured on the intake form)
alter table public.businesses
    add column if not exists tech_contact_email text;

-- 2. editable email-template store
create table if not exists public.email_templates (
    key         text primary key,
    subject     text not null,
    body        text not null,
    updated_at  timestamptz not null default now()
);

-- seed / refresh the integration-invite template. {{business_name}} is the only
-- placeholder the send function fills; the JSON braces below are literal.
insert into public.email_templates (key, subject, body) values
('business_integration_invite',
 'LYMX integration — one simple read endpoint (the same for any business)',
$invite_tpl$Hi {{business_name}} team,

To let your customers earn and redeem LYMX rewards, we need just one thing from your side: read-only access to the transactions you want to reward. You build one small endpoint; we pull from it on a schedule and handle everything else — matching the customer to their reward wallet, issuing, redeeming, and reporting. Nothing about money or reward wallets ever touches your system.

This is the same simple contract for every business, so there's nothing custom to build for us beyond this.

WHAT TO BUILD: one read-only endpoint

  GET https://<your-domain>/lymx/transactions?since=<ISO-8601 timestamp>

  - Auth: issue us a read-only token; we send it as Authorization: Bearer <token>.
  - Returns the transactions created since the given time, as a JSON array.
  - Include only the fee types you choose to reward — not every transaction.

EACH TRANSACTION = 5 PLAIN FIELDS

  [
    {
      "transaction_id": "your-unique-id",      // any stable unique id — we use it to never double-count
      "occurred_at": "2026-05-30T18:00:00Z",   // date / time
      "type": "admin_fee",                      // your own label for the fee type
      "amount": 200.00,                         // in dollars
      "customer_ref": "your-customer-id"        // your own handle for the customer (id, email, or phone)
    }
  ]

That's the entire contract.

  - Read-only. No writes, no payments, no card or bank data, nothing about reward wallets. You're just exposing a list of fee transactions.
  - You choose the fee types. Include only the ones you want to reward; leave the rest out.
  - customer_ref is your own handle — whatever you already use to identify a customer. We match it to a reward wallet on our side; we never ask you to know anything about wallets.
  - We pull, you don't push. We poll your endpoint on a schedule using "since", so there's no ongoing work on your end.

Once it's live, just reply with the endpoint URL and the read-only token, and we take it from there.

Thanks,
The LYMX Team$invite_tpl$)
on conflict (key) do update
    set subject = excluded.subject, body = excluded.body, updated_at = now();

-- 3. send-once log (idempotency: one invite per business)
create table if not exists public.business_integration_invite_log (
    business_id  uuid primary key references public.businesses(id) on delete cascade,
    sent_to      text,
    status       text,
    sent_at      timestamptz not null default now()
);

-- 4. trigger -> EF when intake completes (null -> not null)
create or replace function public.fn_send_integration_invite_on_intake()
returns trigger
language plpgsql
security definer
set search_path = public, net, pg_temp
as $fn$
begin
    if (old.intake_completed_at is null and new.intake_completed_at is not null) then
        perform net.http_post(
            url     := 'https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/send-business-integration-invite',
            body    := jsonb_build_object('business_id', new.id),
            headers := '{"Content-Type":"application/json"}'::jsonb
        );
    end if;
    return new;
end;
$fn$;

drop trigger if exists trg_send_integration_invite on public.businesses;
create trigger trg_send_integration_invite
    after update of intake_completed_at on public.businesses
    for each row execute function public.fn_send_integration_invite_on_intake();

-- 5. RLS + grants (admins manage templates; EF uses service-role and bypasses RLS)
alter table public.email_templates                  enable row level security;
alter table public.business_integration_invite_log  enable row level security;

drop policy if exists et_admin_all on public.email_templates;
create policy et_admin_all on public.email_templates
    for all to authenticated using (public.am_i_admin()) with check (public.am_i_admin());

drop policy if exists biil_admin_r on public.business_integration_invite_log;
create policy biil_admin_r on public.business_integration_invite_log
    for select to authenticated using (public.am_i_admin());

grant select, insert, update on public.email_templates to authenticated;     -- gated by policy
grant select on public.business_integration_invite_log to authenticated;     -- gated by policy

notify pgrst, 'reload schema';
