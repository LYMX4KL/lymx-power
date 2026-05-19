-- =============================================================================
-- Migration 049 — Business ownership transfers (the no-transfer exemption)
-- =============================================================================
-- Per Kenny's hard rule:
--   "LYMX can't be transferred between customers. ONE exemption: when a
--    business is sold, its LYMX inventory transfers as part of the sale to
--    the new owner — provided the new owner stays on the platform."
--
-- Adds:
--   * business_ownership_transfers — audit trail of every ownership change
--   * fn_transfer_business_ownership — RPC that atomically:
--       (a) verifies the buyer has a profile
--       (b) updates businesses.owner_user_id
--       (c) updates business_partners (if seller had one)
--       (d) writes audit row
--       (e) writes fraud_flag at low severity for the record
--   * RLS: only admin/HR can call this
--
-- Note: LYMX in wallets table is keyed by (customer_id, business_id). Customer
-- wallets stay with the customer — they don't change ownership. What changes is
-- WHO OWNS THE BUSINESS, which controls:
--   - who can issue LYMX from that business at the POS
--   - who receives the monthly subscription invoice
--   - who receives the per-redemption settlement
--   - who's listed publicly as the operator
--
-- Idempotent. Safe to re-run.
-- =============================================================================

-- ---------- 1. business_ownership_transfers ----------
create table if not exists public.business_ownership_transfers (
    id              uuid primary key default uuid_generate_v4(),
    business_id     uuid not null references public.businesses(id) on delete restrict,
    from_user_id    uuid references auth.users(id) on delete set null,
    to_user_id      uuid not null references auth.users(id) on delete restrict,

    -- Snapshot of business at time of transfer
    business_name_at_transfer text,
    issued_lymx_snapshot      numeric default 0,   -- total LYMX issued by this biz to date
    accepted_lymx_snapshot    numeric default 0,   -- total LYMX redeemed at this biz to date

    -- Terms
    sale_price_usd     numeric,
    notes              text,

    -- Who processed it
    processed_by       uuid references auth.users(id) on delete set null,
    processed_at       timestamptz not null default now(),
    created_at         timestamptz not null default now()
);

create index if not exists idx_biz_transfers_biz on public.business_ownership_transfers(business_id, processed_at desc);
create index if not exists idx_biz_transfers_to on public.business_ownership_transfers(to_user_id);

alter table public.business_ownership_transfers enable row level security;

drop policy if exists bot_admin_all on public.business_ownership_transfers;
create policy bot_admin_all on public.business_ownership_transfers for all to authenticated
    using (public.am_i_admin() or public.am_i_hr())
    with check (public.am_i_admin() or public.am_i_hr());

-- Business owner can READ transfers for their own business (transparency)
drop policy if exists bot_owner_read on public.business_ownership_transfers;
create policy bot_owner_read on public.business_ownership_transfers for select to authenticated
    using (
        from_user_id = auth.uid()
        OR to_user_id = auth.uid()
    );

-- ---------- 2. RPC — atomic transfer ----------
create or replace function public.fn_transfer_business_ownership(
    p_business_id  uuid,
    p_to_user_id   uuid,
    p_sale_price   numeric default null,
    p_notes        text default null
)
returns uuid
language plpgsql
security definer
as $$
declare
    v_biz             record;
    v_issued_total    numeric;
    v_redeemed_total  numeric;
    v_transfer_id     uuid;
begin
    -- Admin gate
    if not (public.am_i_admin() or public.am_i_hr()) then
        raise exception 'permission denied: only admin or HR can transfer business ownership';
    end if;

    -- Lookup current state
    select * into v_biz from public.businesses where id = p_business_id;
    if not found then
        raise exception 'business % not found', p_business_id;
    end if;

    if v_biz.owner_user_id = p_to_user_id then
        raise exception 'business is already owned by user %', p_to_user_id;
    end if;

    -- Verify the buyer exists in auth.users
    if not exists (select 1 from auth.users where id = p_to_user_id) then
        raise exception 'buyer user % does not exist', p_to_user_id;
    end if;

    -- Snapshot LYMX issued + redeemed
    select coalesce(sum(amount_lymx), 0)
      into v_issued_total
      from public.lymx_issuances
     where source_business_id = p_business_id;

    select coalesce(sum(abs(lymx_amount)), 0)
      into v_redeemed_total
      from public.transactions
     where business_id = p_business_id and type = 'redemption';

    -- Update ownership
    update public.businesses
       set owner_user_id = p_to_user_id,
           updated_at = now()
     where id = p_business_id;

    -- Update business_partners table (if seller had a row)
    update public.business_partners
       set user_id = p_to_user_id, role = coalesce(role, 'owner')
     where business_id = p_business_id and user_id = v_biz.owner_user_id;

    -- Write audit row
    insert into public.business_ownership_transfers (
        business_id, from_user_id, to_user_id,
        business_name_at_transfer,
        issued_lymx_snapshot, accepted_lymx_snapshot,
        sale_price_usd, notes,
        processed_by
    ) values (
        p_business_id, v_biz.owner_user_id, p_to_user_id,
        coalesce(v_biz.display_name, v_biz.legal_name),
        v_issued_total, v_redeemed_total,
        p_sale_price, p_notes,
        auth.uid()
    ) returning id into v_transfer_id;

    -- Also log to fraud_flags at LOW severity for the trail
    insert into public.fraud_flags (
        flag_type, severity, status,
        subject_kind, subject_id,
        business_id, user_id, related_user_id,
        summary,
        detection_data,
        reviewer_id, reviewed_at
    ) values (
        'business_sale', 'low', 'cleared',
        'business_transfer', v_transfer_id,
        p_business_id, v_biz.owner_user_id, p_to_user_id,
        'Business "' || coalesce(v_biz.display_name, v_biz.legal_name, 'unknown') || '" ownership transferred from ' || coalesce(v_biz.owner_user_id::text, 'null') || ' to ' || p_to_user_id::text || ' by admin.',
        jsonb_build_object(
            'transfer_id', v_transfer_id,
            'business_id', p_business_id,
            'from_user_id', v_biz.owner_user_id,
            'to_user_id', p_to_user_id,
            'issued_lymx_snapshot', v_issued_total,
            'accepted_lymx_snapshot', v_redeemed_total,
            'sale_price_usd', p_sale_price
        ),
        auth.uid(), now()
    );

    return v_transfer_id;
end;
$$;

grant execute on function public.fn_transfer_business_ownership(uuid, uuid, numeric, text) to authenticated;

-- ---------- 3. Verify ----------
select 'migration 049 applied' as status,
       (select count(*) from information_schema.tables where table_schema='public'
         and table_name = 'business_ownership_transfers') as new_table,
       (select count(*) from pg_proc where proname = 'fn_transfer_business_ownership') as new_rpc;
