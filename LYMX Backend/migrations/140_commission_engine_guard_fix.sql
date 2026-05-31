-- =============================================================================
-- Migration 140 — relax commission-engine admin guard for server context
-- =============================================================================
-- run_commission_period() + backfill_activation_bonuses() guarded on am_i_admin(),
-- which returns FALSE in the Supabase SQL editor / cron (no auth.uid()), so the
-- intended one-time backfill + monthly run failed with "admin-only". New guard:
-- allow the trusted SERVER context (auth.uid() is null = SQL editor / cron /
-- service role) OR an authenticated admin; still blocks a logged-in non-admin.
-- Idempotent (create or replace). Bodies are otherwise identical to migration 139.
-- =============================================================================

create or replace function public.run_commission_period(p_period_start date, p_period_end date)
returns jsonb
language plpgsql security definer set search_path = public, auth, pg_temp
as $run$
declare
  cfg public.commission_rate_config%rowtype;
  rrec record;
  urec record;
  v_direct uuid;
  v_founding boolean;
  v_fee numeric;
  v_dir_rate numeric;
  v_gen_rate numeric;
  v_rows int := 0;
begin
  if auth.uid() is not null and not public.am_i_admin() then raise exception 'run_commission_period is admin-only'; end if;
  select * into cfg from public.commission_rate_config where is_current limit 1;
  if not found then raise exception 'no current commission_rate_config'; end if;

  -- Idempotency: clear only UNSETTLED rows for this period + recurring streams.
  delete from public.partner_commissions
   where settlement_id is null
     and period_month = p_period_start
     and source_kind in ('transaction_fee', 'monthly_fee');

  -- ===== Stream B: transaction-fee commissions (paid in LYMX) =====
  -- Base = LYMX VOLUME (issued + redeemed) per business per period, mirroring the
  -- canonical split in fn_compute_business_settlement (mig 105): issued = amount_lymx
  -- where reason <> 'redemption'; redeemed = -amount_lymx where reason = 'redemption';
  -- admin_status in (auto,approved). The 3% platform fee is charged on that LYMX
  -- volume, and the MGC is paid (in LYMX) on the fee. (NOT on transaction USD.)
  for rrec in
    select li.business_id, b.signed_up_by_partner_id as direct,
           ( coalesce(sum(li.amount_lymx)  filter (where li.reason <> 'redemption'), 0)
           + coalesce(-sum(li.amount_lymx) filter (where li.reason  = 'redemption'), 0) ) as lymx_volume
      from public.lymx_issuances li
      join public.businesses b on b.id = li.business_id
     where li.admin_status in ('auto','approved')
       and li.created_at >= p_period_start::timestamptz
       and li.created_at <  (p_period_end + 1)::timestamptz
     group by li.business_id, b.signed_up_by_partner_id
  loop
    v_direct := rrec.direct;
    if v_direct is null then continue; end if;
    -- fee is in LYMX units: 3% of the LYMX volume
    v_fee := round((cfg.transaction_fee_pct / 100.0) * rrec.lymx_volume, 2);
    if v_fee <= 0 then continue; end if;
    select coalesce(is_founding_25, false) into v_founding from public.partners where id = v_direct;
    v_dir_rate := case when v_founding then cfg.direct_pct_founding else cfg.direct_pct_regular end;
    insert into public.partner_commissions
      (partner_id, source_business_id, source_partner_id, type, source_kind, generation, amount, payout_kind, period_month)
    values (v_direct, rrec.business_id, v_direct, 'override', 'transaction_fee', 0,
            round(v_dir_rate / 100.0 * v_fee, 2), 'lymx', p_period_start);
    v_rows := v_rows + 1;
    for urec in select * from public.fn_partner_upline(v_direct) loop
      v_gen_rate := case urec.generation when 1 then cfg.g1_pct when 2 then cfg.g2_pct when 3 then cfg.g3_pct else 0 end;
      if v_gen_rate > 0 then
        insert into public.partner_commissions
          (partner_id, source_business_id, source_partner_id, type, source_kind, generation, amount, payout_kind, period_month)
        values (urec.partner_id, rrec.business_id, v_direct, 'override', 'transaction_fee', urec.generation,
                round(v_gen_rate / 100.0 * v_fee, 2), 'lymx', p_period_start);
        v_rows := v_rows + 1;
      end if;
    end loop;
  end loop;

  -- ===== Stream C: monthly-fee commissions (paid in CASH), past free months =====
  for rrec in
    select bs.business_id, bs.monthly_amount, b.signed_up_by_partner_id as direct
      from public.business_subscriptions bs
      join public.businesses b on b.id = bs.business_id
     where bs.status = 'active'
       and coalesce(bs.trial_ends_at,
                    bs.created_at + (cfg.monthly_fee_free_months || ' months')::interval) < p_period_start
  loop
    v_direct := rrec.direct;
    if v_direct is null or coalesce(rrec.monthly_amount, 0) <= 0 then continue; end if;
    v_fee := rrec.monthly_amount;
    select coalesce(is_founding_25, false) into v_founding from public.partners where id = v_direct;
    v_dir_rate := case when v_founding then cfg.direct_pct_founding else cfg.direct_pct_regular end;
    insert into public.partner_commissions
      (partner_id, source_business_id, source_partner_id, type, source_kind, generation, amount, payout_kind, period_month, source_subscription_id)
    values (v_direct, rrec.business_id, v_direct, 'override', 'monthly_fee', 0,
            round(v_dir_rate / 100.0 * v_fee, 2), 'cash', p_period_start, null);
    v_rows := v_rows + 1;
    for urec in select * from public.fn_partner_upline(v_direct) loop
      v_gen_rate := case urec.generation when 1 then cfg.g1_pct when 2 then cfg.g2_pct when 3 then cfg.g3_pct else 0 end;
      if v_gen_rate > 0 then
        insert into public.partner_commissions
          (partner_id, source_business_id, source_partner_id, type, source_kind, generation, amount, payout_kind, period_month)
        values (urec.partner_id, rrec.business_id, v_direct, 'override', 'monthly_fee', urec.generation,
                round(v_gen_rate / 100.0 * v_fee, 2), 'cash', p_period_start);
        v_rows := v_rows + 1;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('ok', true, 'rows', v_rows, 'period_start', p_period_start, 'period_end', p_period_end);
end$run$;
grant execute on function public.run_commission_period(date, date) to authenticated;

create or replace function public.backfill_activation_bonuses()
returns int
language plpgsql security definer set search_path = public, auth, pg_temp
as $bf$
declare r record; n int := 0;
begin
  if auth.uid() is not null and not public.am_i_admin() then raise exception 'admin-only'; end if;
  for r in select id from public.businesses
            where signed_up_by_partner_id is not null and archived_at is null
  loop
    perform public.accrue_activation_bonus(r.id);
    n := n + 1;
  end loop;
  return n;
end$bf$;
grant execute on function public.backfill_activation_bonuses() to authenticated;

do $s$ begin raise notice 'Migration 140 OK - engine guards now allow server context.'; end$s$;
-- END migration 140
