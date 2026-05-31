-- =============================================================================
-- Migration 148 — partner_benchmarks(): you-vs-network comparison
-- =============================================================================
-- Powers the income projector's "You vs the network" panel so partners see
-- where they lag/lead and where to focus. SECURITY DEFINER (sitewide aggregates
-- aren't readable by a partner under RLS), returns ONLY aggregates — no other
-- partner's identity or row-level data. Authorized: own partner or admin.
-- Metrics: activations (businesses signed), direct recruits (G1), lifetime cash,
-- and avg LYMX volume (issued+redeemed) per business — each as YOU vs site avg
-- vs site top.
-- =============================================================================

create or replace function public.partner_benchmarks(p_partner_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $bm$
declare
  result            jsonb;
  v_you_act         int;
  v_you_recruits    int;
  v_you_cash        numeric;
  v_you_vol         numeric;
  v_site_avg_act    numeric;
  v_site_top_act    int;
  v_site_avg_recr   numeric;
  v_site_avg_cash   numeric;
  v_site_avg_vol    numeric;
begin
  if auth.uid() is not null
     and not public.am_i_admin()
     and p_partner_id is distinct from public.current_partner_id() then
    raise exception 'not authorized';
  end if;

  -- YOU: activations (businesses you signed, active)
  select count(*) into v_you_act
    from public.businesses
   where signed_up_by_partner_id = p_partner_id and archived_at is null;

  -- YOU: direct recruits (G1 partners you sponsor)
  select count(*) into v_you_recruits
    from public.partners
   where sponsor_partner_id = p_partner_id and archived_at is null;

  -- YOU: lifetime cash earned
  select coalesce(sum(amount), 0) into v_you_cash
    from public.partner_commissions
   where partner_id = p_partner_id and payout_kind = 'cash';

  -- YOU: avg LYMX volume (issued+redeemed) across your businesses
  select coalesce(avg(vol), 0) into v_you_vol from (
    select li.business_id,
           coalesce(sum(li.amount_lymx) filter (where li.reason <> 'redemption'), 0)
         + coalesce(-sum(li.amount_lymx) filter (where li.reason = 'redemption'), 0) as vol
      from public.lymx_issuances li
      join public.businesses b on b.id = li.business_id
     where b.signed_up_by_partner_id = p_partner_id
       and li.admin_status in ('auto','approved')
     group by li.business_id
  ) yv;

  -- SITE: avg + top activations per partner (only partners with >=1 activation)
  select coalesce(avg(c), 0), coalesce(max(c), 0)
    into v_site_avg_act, v_site_top_act
    from (
      select signed_up_by_partner_id, count(*) c
        from public.businesses
       where signed_up_by_partner_id is not null and archived_at is null
       group by signed_up_by_partner_id
    ) pa;

  -- SITE: avg direct recruits per sponsoring partner
  select coalesce(avg(c), 0) into v_site_avg_recr
    from (
      select sponsor_partner_id, count(*) c
        from public.partners
       where sponsor_partner_id is not null and archived_at is null
       group by sponsor_partner_id
    ) pr;

  -- SITE: avg lifetime cash per earning partner
  select coalesce(avg(s), 0) into v_site_avg_cash
    from (
      select partner_id, sum(amount) s
        from public.partner_commissions
       where payout_kind = 'cash'
       group by partner_id
    ) pc;

  -- SITE: avg LYMX volume per business (all businesses)
  select coalesce(avg(vol), 0) into v_site_avg_vol from (
    select li.business_id,
           coalesce(sum(li.amount_lymx) filter (where li.reason <> 'redemption'), 0)
         + coalesce(-sum(li.amount_lymx) filter (where li.reason = 'redemption'), 0) as vol
      from public.lymx_issuances li
     where li.admin_status in ('auto','approved')
     group by li.business_id
  ) sv;

  result := jsonb_build_object(
    'you', jsonb_build_object(
      'activations', v_you_act,
      'direct_recruits', v_you_recruits,
      'cash_lifetime', round(v_you_cash, 2),
      'avg_lymx_volume_per_biz', round(v_you_vol)
    ),
    'site', jsonb_build_object(
      'avg_activations', round(v_site_avg_act, 1),
      'top_activations', v_site_top_act,
      'avg_direct_recruits', round(v_site_avg_recr, 1),
      'avg_cash_lifetime', round(v_site_avg_cash, 2),
      'avg_lymx_volume_per_biz', round(v_site_avg_vol)
    )
  );
  return result;
end$bm$;
grant execute on function public.partner_benchmarks(uuid) to authenticated;

do $s$ begin raise notice 'Migration 148 OK - partner_benchmarks() ready.'; end$s$;
-- END migration 148
