-- =============================================================================
-- Migration 146 — Founding-25 $1,000 speed bonus accrual
-- =============================================================================
-- The comp plan promises founding partners a one-time $1,000 speed bonus for
-- hitting `founding_speed_count` (5) activations within `founding_speed_window_months`
-- (3) of joining. The config (mig 138) has the params but nothing ever computed
-- it — founding partners would never be paid it. This adds:
--   - accrue_speed_bonus(partner)         : idempotent, config-driven
--   - accrue_activation_bonus(business)   : now also triggers the speed-bonus check
--   - backfill_speed_bonuses()            : sweep existing founding partners
--   - trg_emit_commission_notification    : celebratory message for speed_bonus
-- Window anchor = partner.created_at (their "first 3 months"), matching the
-- milestone copy shipped in mig 143. Cash payout. Idempotent everywhere.
-- =============================================================================

set local statement_timeout = 0;
begin;

-- 1. speed-bonus accrual ----------------------------------------------------
create or replace function public.accrue_speed_bonus(p_partner_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $sb$
declare
  cfg       public.commission_rate_config%rowtype;
  v_founding boolean;
  v_anchor  timestamptz;
  v_count   int;
  v_amount  numeric;
begin
  if p_partner_id is null then return; end if;
  select * into cfg from public.commission_rate_config where is_current limit 1;
  if not found then return; end if;

  select coalesce(is_founding_25, false), created_at
    into v_founding, v_anchor
    from public.partners where id = p_partner_id;
  if not v_founding then return; end if;

  -- already paid the speed bonus? (idempotent — one per partner, ever)
  if exists (select 1 from public.partner_commissions
              where partner_id = p_partner_id and source_kind = 'speed_bonus') then
    return;
  end if;

  -- count this partner's OWN activations (gen 0) that landed inside the window
  select count(*) into v_count
    from public.partner_commissions
   where partner_id = p_partner_id
     and source_kind = 'activation'
     and generation = 0
     and created_at <= v_anchor + (cfg.founding_speed_window_months || ' months')::interval;

  if v_count >= cfg.founding_speed_count then
    v_amount := cfg.founding_speed_bonus_cents::numeric / 100.0;
    insert into public.partner_commissions
      (partner_id, source_partner_id, type, source_kind, generation, amount, payout_kind, period_month)
    values
      (p_partner_id, p_partner_id, 'qualifier_bonus', 'speed_bonus', 0, v_amount, 'cash', null);
  end if;
end$sb$;
grant execute on function public.accrue_speed_bonus(uuid) to authenticated;

-- 2. activation bonus now also checks the speed bonus -----------------------
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
  if exists (select 1 from public.partner_commissions
              where source_business_id = p_business_id and source_kind = 'activation') then
    -- activation already accrued; still re-check speed bonus (idempotent) and return
    perform public.accrue_speed_bonus(v_direct);
    return;
  end if;
  select coalesce(is_founding_25, false) into v_founding from public.partners where id = v_direct;
  v_amount := (case when v_founding then cfg.activation_bonus_founding_cents
                    else cfg.activation_bonus_regular_cents end)::numeric / 100.0;
  insert into public.partner_commissions
    (partner_id, source_business_id, source_partner_id, type, source_kind, generation, amount, payout_kind, period_month)
  values
    (v_direct, p_business_id, v_direct, 'signup_bonus', 'activation', 0, v_amount, 'cash', null);

  -- check whether this activation tips them into the founding speed bonus
  perform public.accrue_speed_bonus(v_direct);
end$act$;
grant execute on function public.accrue_activation_bonus(uuid) to authenticated;

-- 3. backfill existing founding partners ------------------------------------
create or replace function public.backfill_speed_bonuses()
returns int
language plpgsql security definer set search_path = public, pg_temp
as $bf$
declare r record; n int := 0;
begin
  if auth.uid() is not null and not public.am_i_admin() then
    raise exception 'admin-only';
  end if;
  for r in select id from public.partners where coalesce(is_founding_25, false) = true and archived_at is null
  loop
    perform public.accrue_speed_bonus(r.id);
    n := n + 1;
  end loop;
  return n;
end$bf$;
grant execute on function public.backfill_speed_bonuses() to authenticated;

-- 4. celebratory notification for the speed bonus ---------------------------
create or replace function public.trg_emit_commission_notification()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $trg_comm$
declare
    v_title    text;
    v_body     text;
    v_biz      text;
    v_kind     text := 'commission_earned';
    v_is_lymx  boolean := (new.payout_kind = 'lymx');
    v_amt_txt  text;
    v_count    int;
begin
    select coalesce(display_name, legal_name, 'A business')
      into v_biz from public.businesses where id = new.source_business_id;

    v_amt_txt := case when v_is_lymx
        then to_char(new.amount, 'FM999,999,990') || ' LYMX'
        else '$' || to_char(new.amount, 'FM999,990.00') end;

    if new.source_kind = 'speed_bonus' then
        v_kind  := 'milestone';
        v_title := '🚀 ' || v_amt_txt || ' Founding speed bonus earned!';
        v_body  := 'You hit 5 activations inside your first 3 months. The $1,000 founding speed bonus is on its way to your payout. Incredible work!';
    elsif new.source_kind = 'activation' then
        v_kind  := 'direct_activation';
        v_title := '🎉 Activation bonus: ' || v_amt_txt || ' is on its way!';
        v_body  := coalesce(v_biz, 'A business') || ' just activated — your sign-up bonus has been added to your next payout. Nice work!';
    elsif new.source_kind = 'transaction_fee' then
        v_title := 'You earned ' || v_amt_txt || ' in network rewards';
        v_body  := 'Transaction-fee override from ' || coalesce(v_biz, 'your network') ||
                   case when new.generation > 0 then ' (G' || new.generation || ' downline).' else '.' end;
    elsif new.source_kind = 'monthly_fee' then
        v_title := 'You earned ' || v_amt_txt || ' override';
        v_body  := 'Monthly-fee override from ' || coalesce(v_biz, 'your network') ||
                   case when new.generation > 0 then ' (G' || new.generation || ' downline).' else '.' end;
    else
        v_title := 'You earned ' || v_amt_txt || ' commission';
        v_body  := 'New commission added to your settlement queue.';
    end if;

    perform public.fn_emit_partner_notification(
        p_partner_id          := new.partner_id,
        p_kind                := v_kind,
        p_title               := v_title,
        p_body                := v_body,
        p_target_url          := '/income-statement.html',
        p_related_entity_type := 'partner_commission',
        p_related_entity_id   := new.id
    );

    if new.source_kind = 'activation' and new.generation = 0 then
        select count(*) into v_count
          from public.partner_commissions
         where partner_id = new.partner_id and source_kind = 'activation' and generation = 0;
        if v_count in (1, 5, 10, 25) then
            perform public.fn_emit_partner_notification(
                p_partner_id := new.partner_id,
                p_kind       := 'milestone',
                p_title      := case v_count
                                  when 1  then '🏅 First activation unlocked!'
                                  when 5  then '🔥 5 activations — speed-bonus window!'
                                  when 10 then '⭐ 10 activations — you are on fire!'
                                  else '👑 25 activations — elite tier!' end,
                p_body       := case v_count
                                  when 5 then 'Five businesses activated. If these landed within your first 3 months you qualify for the $1,000 speed bonus.'
                                  else 'You have now activated ' || v_count || ' businesses. Keep building your network!' end,
                p_target_url := '/rep-dashboard.html',
                p_related_entity_type := 'milestone',
                p_related_entity_id   := new.id
            );
        end if;
    end if;

    return new;
end
$trg_comm$;

commit;
do $s$ begin raise notice 'Migration 146 OK - founding speed bonus accrual + backfill + celebration.'; end$s$;
-- END migration 146
