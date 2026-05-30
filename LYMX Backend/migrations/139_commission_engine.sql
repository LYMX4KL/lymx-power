-- =============================================================================
-- Migration 139 — Commission ENGINE (MGC accrual) — depends on mig 138
-- =============================================================================
-- Computes partner_commissions from real activity, config-driven (mig 138):
--   * accrue_activation_bonus(business)  one-time CASH to the direct partner
--   * run_commission_period(start,end)   recurring: transaction-fee (LYMX, base =
--                                         LYMX issued+redeemed) + monthly-fee (CASH), MGC gens 0/1/2/3
--   * partner_income_summary(partner)    real earned income for dashboards/projector
-- Idempotency: recurring streams DELETE only UNSETTLED rows for the period+stream
-- then re-insert; SETTLED (paid) rows are immutable. Activation skips if already
-- accrued for that business. All amounts are USD dollars in partner_commissions.amount;
-- payout_kind says whether it's paid in cash or as LYMX network credit.
-- =============================================================================

-- ---------- upline G1/G2/G3 via sponsor_partner_id --------------------------
create or replace function public.fn_partner_upline(p_partner_id uuid)
returns table(generation int, partner_id uuid)
language sql stable security definer set search_path = public, pg_temp
as $up$
  with recursive chain as (
    select 0 as gen, p.id, p.sponsor_partner_id
      from public.partners p where p.id = p_partner_id
    union all
    select c.gen + 1, sp.id, sp.sponsor_partner_id
      from chain c
      join public.partners sp on sp.id = c.sponsor_partner_id
     where c.gen < 3
  )
  select gen, id from chain where gen between 1 and 3;
$up$;
grant execute on function public.fn_partner_upline(uuid) to authenticated;

-- ---------- one-time activation bonus (cash, direct partner) ----------------
create or replace function public.accrue_activation_bonus(p_business_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $act$
declare
  cfg public.commission_rate_config%rowtype;
  v_direct uuid;
  v_founding boolean;
  v_amount numeric;
begin
  select * into cfg from public.commission_rate_config where is_current limit 1;
  if not found then raise exception 'no current commission_rate_config'; end if;
  select signed_up_by_partner_id into v_direct from public.businesses where id = p_business_id;
  if v_direct is null then return; end if;
  -- already accrued for this business? (idempotent)
  if exists (select 1 from public.partner_commissions
              where source_business_id = p_business_id and source_kind = 'activation') then
    return;
  end if;
  select coalesce(is_founding_25, false) into v_founding from public.partners where id = v_direct;
  v_amount := (case when v_founding then cfg.activation_bonus_founding_cents
                    else cfg.activation_bonus_regular_cents end)::numeric / 100.0;
  insert into public.partner_commissions
    (partner_id, source_business_id, source_partner_id, type, source_kind, generation, amount, payout_kind, period_month)
  values
    (v_direct, p_business_id, v_direct, 'signup_bonus', 'activation', 0, v_amount, 'cash', null);
end$act$;
grant execute on function public.accrue_activation_bonus(uuid) to authenticated;

-- ---------- recurring period run (transaction-fee + monthly-fee) ------------
create or replace function public.run_commission_period(p_period_start date, p_period_end date)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
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
  if not public.am_i_admin() then raise exception 'run_commission_period is admin-only'; end if;
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

-- ---------- backfill activation bonuses for existing signed businesses ------
create or replace function public.backfill_activation_bonuses()
returns int
language plpgsql security definer set search_path = public, pg_temp
as $bf$
declare r record; n int := 0;
begin
  if not public.am_i_admin() then raise exception 'admin-only'; end if;
  for r in select id from public.businesses
            where signed_up_by_partner_id is not null and archived_at is null
  loop
    perform public.accrue_activation_bonus(r.id);
    n := n + 1;
  end loop;
  return n;
end$bf$;
grant execute on function public.backfill_activation_bonuses() to authenticated;

-- ---------- real earned-income summary (for dashboards + projector) ---------
create or replace function public.partner_income_summary(p_partner_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $sum$
  select jsonb_build_object(
    'cash_total',  coalesce(sum(amount) filter (where payout_kind = 'cash'), 0),
    'lymx_total',  coalesce(sum(amount) filter (where payout_kind = 'lymx'), 0),
    'paid_total',  coalesce(sum(amount) filter (where settlement_id is not null), 0),
    'unpaid_total',coalesce(sum(amount) filter (where settlement_id is null), 0),
    'by_stream', (
      select coalesce(jsonb_object_agg(s.source_kind, s.amt), '{}'::jsonb)
        from (select source_kind, sum(amount) as amt
                from public.partner_commissions
               where partner_id = p_partner_id group by source_kind) s
    ),
    'by_generation', (
      select coalesce(jsonb_object_agg(g.generation::text, g.amt), '{}'::jsonb)
        from (select generation, sum(amount) as amt
                from public.partner_commissions
               where partner_id = p_partner_id group by generation) g
    )
  )
  from public.partner_commissions
  where partner_id = p_partner_id;
$sum$;
grant execute on function public.partner_income_summary(uuid) to authenticated;

do $s$ begin raise notice 'Migration 139 OK - commission engine (accrual + period run + income summary).'; end$s$;
-- END migration 139
