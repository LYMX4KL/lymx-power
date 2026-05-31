-- =============================================================================
-- Migration 143 — income notifications (celebration + milestones) + statement RPC
-- =============================================================================
-- Builds on the existing notification system (mig 109/110):
--   1. Specialize the partner_commissions INSERT trigger so an ACTIVATION bonus
--      fires a celebratory message (big sign-up fee landing), LYMX-payout rows
--      read in LYMX units (not $), and other rows stay sensible.
--   2. Emit MILESTONE notifications when a partner crosses activation counts
--      (1st, 5th = speed-bonus window, 10th, 25th).
--   3. fn_partner_income_statement(partner, limit) — per-transaction line items
--      with business names, for the "where my income comes from" statement.
--      SECURITY DEFINER + caller authorization (own partner or admin).
-- Idempotent. Named dollar-quotes throughout.
-- =============================================================================

set local statement_timeout = 0;
begin;

-- ---------------------------------------------------------------------------
-- 1. widen notification kinds (add 'milestone' and 'daily_income')
-- ---------------------------------------------------------------------------
alter table public.partner_notifications drop constraint if exists partner_notifications_kind_check;
alter table public.partner_notifications add constraint partner_notifications_kind_check
    check (kind in (
        'commission_earned','direct_activation','downline_signup',
        'qualifier_progress','settlement_paid','system',
        'milestone','daily_income'
    ));

-- ---------------------------------------------------------------------------
-- 2. specialized commission-insert notification
-- ---------------------------------------------------------------------------
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

    if new.source_kind = 'activation' then
        -- The big one: cash sign-up bonus on a business the partner activated.
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

    -- Milestone celebration on the partner's OWN activations (generation 0, cash)
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

-- ---------------------------------------------------------------------------
-- 3. per-transaction income statement (line items + business names)
-- ---------------------------------------------------------------------------
create or replace function public.fn_partner_income_statement(
    p_partner_id uuid,
    p_limit int default 500
) returns table(
    id uuid, created_at timestamptz, source_kind text, comm_type text,
    generation int, amount numeric, payout_kind text,
    settled boolean, settlement_id uuid, business_name text
)
language plpgsql stable security definer set search_path = public, pg_temp
as $stmt$
begin
    if auth.uid() is not null
       and not public.am_i_admin()
       and p_partner_id is distinct from public.current_partner_id() then
        raise exception 'not authorized to read this statement';
    end if;

    return query
    select pc.id, pc.created_at, pc.source_kind, pc.type, pc.generation,
           pc.amount, pc.payout_kind,
           (pc.settlement_id is not null) as settled, pc.settlement_id,
           coalesce(b.display_name, b.legal_name, '—') as business_name
      from public.partner_commissions pc
      left join public.businesses b on b.id = pc.source_business_id
     where pc.partner_id = p_partner_id
     order by pc.created_at desc
     limit greatest(1, least(p_limit, 2000));
end
$stmt$;
grant execute on function public.fn_partner_income_statement(uuid, int) to authenticated;

commit;
do $s$ begin raise notice 'Migration 143 OK - celebration + milestones + statement RPC.'; end$s$;
-- END migration 143
