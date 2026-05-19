-- =============================================================================
-- Migration 048 — Fraud prevention layer (Kenny 2026-05-18 spec)
-- =============================================================================
-- Hard rules:
--   1. LYMX is NOT transferable between customers. Sole issuer = platform.
--   2. LYMX is only purchased FROM the platform (by businesses, against real
--      transactions). LYMX is only sold back TO the platform (at 80%).
--   3. Self-issuance risk: a business owner who issues LYMX to their own
--      account is buying LYMX at 80% and could spend at face value elsewhere
--      (20% arbitrage). Auto-flag these for admin review.
--   4. Exemption: when a business is sold, its LYMX inventory transfers to the
--      new owner via an explicit admin-only `business_lymx_transfer` row.
--
-- Adds:
--   * fraud_flags          — log of suspicious issuance / transfer attempts
--   * RLS: block customer↔customer transfers on `transactions` table
--   * trigger: detect self-issuance on lymx_issuances + write to fraud_flags
--   * helper: fn_is_business_owner(user_uuid)
--
-- Idempotent. Safe to re-run.
-- =============================================================================

-- ---------- 1. fraud_flags table ----------
create table if not exists public.fraud_flags (
    id              uuid primary key default uuid_generate_v4(),
    flag_type       text not null,                 -- 'self_issuance' | 'cust_to_cust_transfer' | 'velocity_spike' | 'manual'
    severity        text not null default 'medium',-- 'low' | 'medium' | 'high' | 'critical'
    status          text not null default 'open',  -- 'open' | 'reviewing' | 'cleared' | 'confirmed'

    -- Subject of the flag
    subject_kind    text,                          -- 'issuance' | 'transaction' | 'partner' | 'business'
    subject_id      uuid,                          -- FK-style pointer (not enforced — multi-table)
    business_id     uuid references public.businesses(id) on delete set null,
    user_id         uuid references auth.users(id) on delete set null,
    related_user_id uuid references auth.users(id) on delete set null,

    -- Numbers
    amount_lymx     numeric,
    amount_usd      numeric,

    -- Narrative
    summary         text not null,
    detection_data  jsonb,                         -- raw fields for the admin to inspect
    reviewer_id     uuid references auth.users(id) on delete set null,
    reviewed_at     timestamptz,
    reviewer_notes  text,

    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index if not exists idx_fraud_flags_status_severity
    on public.fraud_flags(status, severity, created_at desc);
create index if not exists idx_fraud_flags_business
    on public.fraud_flags(business_id, created_at desc);
create index if not exists idx_fraud_flags_user
    on public.fraud_flags(user_id, created_at desc);

create or replace function public.touch_fraud_flags_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists trg_fraud_flags_updated on public.fraud_flags;
create trigger trg_fraud_flags_updated before update on public.fraud_flags
    for each row execute function public.touch_fraud_flags_updated_at();

alter table public.fraud_flags enable row level security;

drop policy if exists ff_admin_read on public.fraud_flags;
create policy ff_admin_read on public.fraud_flags for select to authenticated
    using (public.am_i_admin());

drop policy if exists ff_admin_write on public.fraud_flags;
create policy ff_admin_write on public.fraud_flags for all to authenticated
    using (public.am_i_admin()) with check (public.am_i_admin());

-- ---------- 2. fn_is_business_owner ----------
create or replace function public.fn_is_business_owner(p_user_id uuid)
returns boolean
language sql stable security definer
as $$
    select exists (
        select 1 from public.businesses
         where owner_user_id = p_user_id
           and archived_at is null
    );
$$;

grant execute on function public.fn_is_business_owner(uuid) to authenticated;

-- ---------- 3. Block customer-to-customer transfers via RLS ----------
-- The transactions table has type values including 'transfer_in' / 'transfer_out'.
-- New rule: those types are NEVER insertable by authenticated users directly.
-- Only the platform (service role / admin) can insert them — and only for the
-- business-sale inventory transfer exemption.
drop policy if exists tx_no_customer_transfers on public.transactions;
create policy tx_no_customer_transfers on public.transactions for insert to authenticated
    with check (
        type not in ('transfer_in','transfer_out')
        OR public.am_i_admin()
    );

-- ---------- 4. Trigger: detect self-issuance ----------
-- When a business issues LYMX to a recipient whose user_id equals the business's
-- own owner_user_id, write a 'self_issuance' flag to fraud_flags. Critical-severity
-- so it surfaces immediately on the admin dashboard.
create or replace function public.detect_self_issuance()
returns trigger
language plpgsql security definer
as $$
declare
    v_owner_user_id uuid;
    v_biz_name      text;
begin
    -- Only check issuances tied to a source business
    if new.source_business_id is null then
        return new;
    end if;

    select owner_user_id, coalesce(display_name, legal_name)
      into v_owner_user_id, v_biz_name
      from public.businesses
     where id = new.source_business_id;

    if v_owner_user_id is null then
        return new;
    end if;

    -- Self-issuance: business issuing to its own owner
    if v_owner_user_id = new.recipient_user_id then
        insert into public.fraud_flags (
            flag_type, severity, status,
            subject_kind, subject_id,
            business_id, user_id,
            amount_lymx,
            summary,
            detection_data
        ) values (
            'self_issuance', 'high', 'open',
            'issuance', new.id,
            new.source_business_id, new.recipient_user_id,
            new.amount_lymx,
            'Business "' || coalesce(v_biz_name, 'unknown') || '" issued ' || new.amount_lymx::text || ' LYMX to its own owner. 20% arbitrage risk (owner paid 80% → can spend at face value at other businesses).',
            jsonb_build_object(
                'issuance_id', new.id,
                'business_id', new.source_business_id,
                'business_name', v_biz_name,
                'owner_user_id', v_owner_user_id,
                'recipient_user_id', new.recipient_user_id,
                'amount_lymx', new.amount_lymx,
                'reason', new.reason
            )
        );
    end if;

    return new;
end;
$$;

drop trigger if exists trg_detect_self_issuance on public.lymx_issuances;
create trigger trg_detect_self_issuance after insert on public.lymx_issuances
    for each row execute function public.detect_self_issuance();

-- ---------- 5. View: v_open_fraud_flags for the admin dashboard ----------
create or replace view public.v_open_fraud_flags as
select
    f.id,
    f.flag_type,
    f.severity,
    f.status,
    f.subject_kind,
    f.subject_id,
    f.business_id,
    b.display_name as business_name,
    f.user_id,
    f.amount_lymx,
    f.summary,
    f.created_at
  from public.fraud_flags f
  left join public.businesses b on b.id = f.business_id
 where f.status in ('open', 'reviewing')
 order by
    case f.severity
        when 'critical' then 1
        when 'high'     then 2
        when 'medium'   then 3
        when 'low'      then 4
    end,
    f.created_at desc;

alter view public.v_open_fraud_flags set (security_invoker = on);
grant select on public.v_open_fraud_flags to authenticated;

-- ---------- 6. Verify ----------
select 'migration 048 applied' as status,
       (select count(*) from information_schema.tables where table_schema='public'
         and table_name = 'fraud_flags') as new_table,
       (select count(*) from pg_proc where proname in
         ('detect_self_issuance','fn_is_business_owner','touch_fraud_flags_updated_at')) as new_helpers,
       (select count(*) from information_schema.views where table_schema='public'
         and table_name = 'v_open_fraud_flags') as new_view;
