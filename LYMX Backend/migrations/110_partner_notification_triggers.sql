-- =============================================================================
-- Migration 110 — Sprint 3 follow-on: notification triggers + feature catalog
-- =============================================================================
-- Auto-emit triggers that fire fn_emit_partner_notification (mig 109) on the
-- three load-bearing partner events:
--
--   1. partner_commissions INSERT  → 'commission_earned'
--   2. businesses approval flip    → 'direct_activation' (to the Direct partner)
--   3. settlements status='paid'   → 'settlement_paid'
--
-- Plus the feature_catalog rows that gate UI affordances:
--   partner_view_notifications     → partners (default true)
--   admin_emit_partner_notification → admins (manual override / system messages)
--
-- Triggers call fn_emit_partner_notification, which is SECURITY DEFINER. Inside
-- a trigger, auth.uid() is null (running as the table owner), so the emit's
-- "auth.uid() is null = service-role context" gate passes and the insert
-- succeeds — exactly the path we built in mig 109.
--
-- Idempotent: triggers use drop-if-exists pattern.
-- =============================================================================

set local statement_timeout = 0;

begin;

-- =====================================================================
-- 1. feature_catalog rows
-- =====================================================================
insert into public.feature_catalog
    (feature_key, label, description, category, default_for_roles, playbook_slug, page_paths)
values
    ('partner_view_notifications',
     'View My Notifications',
     'See your event feed: commissions earned, downline activations, settlement payouts, system messages.',
     'partner',
     array['partner']::text[],
     'partner-notifications',
     array['/notifications.html']::text[]),

    ('admin_emit_partner_notification',
     'Send Partner Notification',
     'Send a manual notification to a specific partner (or all partners). Used for system announcements, training nudges, or fraud alerts.',
     'admin',
     array[]::text[],
     null,
     array['/admin-notifications.html']::text[])
on conflict (feature_key) do update set
    label             = excluded.label,
    description       = excluded.description,
    category          = excluded.category,
    default_for_roles = excluded.default_for_roles,
    playbook_slug     = excluded.playbook_slug,
    page_paths        = excluded.page_paths,
    is_active         = true,
    updated_at        = now();

-- =====================================================================
-- 2. Trigger: partner_commissions INSERT → 'commission_earned'
-- =====================================================================
create or replace function public.trg_emit_commission_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $trg_comm$
declare
    v_title text;
    v_body  text;
begin
    -- Build a plain-English title from the commission type + amount
    v_title := 'You earned $' || to_char(new.amount, 'FM999,990.00') || ' commission';
    v_body  := case new.type
                  when 'signup_bonus'    then 'New activation bonus deposited to your settlement queue.'
                  when 'override'        then 'Override on a downline activation.'
                  when 'qualifier_bonus' then 'Founding 25 qualifier bonus — you hit 5 activations.'
                  else 'New commission added to your settlement queue.'
               end;

    perform public.fn_emit_partner_notification(
        p_partner_id          := new.partner_id,
        p_kind                := 'commission_earned',
        p_title               := v_title,
        p_body                := v_body,
        p_target_url          := '/partner-payouts.html',
        p_related_entity_type := 'partner_commission',
        p_related_entity_id   := new.id
    );

    return new;
end
$trg_comm$;

drop trigger if exists trg_partner_commissions_notify on public.partner_commissions;
create trigger trg_partner_commissions_notify
    after insert on public.partner_commissions
    for each row execute function public.trg_emit_commission_notification();

-- =====================================================================
-- 3. Trigger: businesses approval flip → 'direct_activation'
-- =====================================================================
create or replace function public.trg_emit_business_approval_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $trg_biz_approve$
declare
    v_partner_id uuid;
begin
    -- Only fire when approval_status transitions to 'approved' from something else
    if new.approval_status is not distinct from 'approved'
       and (old.approval_status is null or old.approval_status <> 'approved')
       and new.signed_up_by_partner_id is not null
    then
        v_partner_id := new.signed_up_by_partner_id;
        perform public.fn_emit_partner_notification(
            p_partner_id          := v_partner_id,
            p_kind                := 'direct_activation',
            p_title               := coalesce(new.display_name, 'A business') || ' just activated',
            p_body                := 'Your Direct activation is live. Commission will deposit on the next settlement run.',
            p_target_url          := '/partner-tree.html',
            p_related_entity_type := 'business',
            p_related_entity_id   := new.id
        );
    end if;
    return new;
end
$trg_biz_approve$;

drop trigger if exists trg_businesses_approval_notify on public.businesses;
create trigger trg_businesses_approval_notify
    after update of approval_status on public.businesses
    for each row execute function public.trg_emit_business_approval_notification();

-- =====================================================================
-- 4. Trigger: settlements status='paid' → 'settlement_paid'
-- =====================================================================
create or replace function public.trg_emit_settlement_paid_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $trg_settle_paid$
begin
    if new.status = 'paid'
       and (old.status is null or old.status <> 'paid')
    then
        perform public.fn_emit_partner_notification(
            p_partner_id          := new.partner_id,
            p_kind                := 'settlement_paid',
            p_title               := 'Settlement paid: $' || to_char(new.total_amount, 'FM999,990.00'),
            p_body                := 'Your ' || new.period_start || ' → ' || new.period_end || ' commissions were just deposited.',
            p_target_url          := '/partner-payouts.html',
            p_related_entity_type := 'settlement',
            p_related_entity_id   := new.id
        );
    end if;
    return new;
end
$trg_settle_paid$;

drop trigger if exists trg_settlements_paid_notify on public.settlements;
create trigger trg_settlements_paid_notify
    after update of status on public.settlements
    for each row execute function public.trg_emit_settlement_paid_notification();

-- =====================================================================
-- 5. Sanity
-- =====================================================================
do $sanity_110$
declare
    v_feature_count int;
    v_trg_comm boolean;
    v_trg_biz  boolean;
    v_trg_set  boolean;
begin
    select count(*) into v_feature_count from public.feature_catalog
     where feature_key in ('partner_view_notifications','admin_emit_partner_notification');
    select exists (select 1 from pg_trigger where tgname='trg_partner_commissions_notify') into v_trg_comm;
    select exists (select 1 from pg_trigger where tgname='trg_businesses_approval_notify') into v_trg_biz;
    select exists (select 1 from pg_trigger where tgname='trg_settlements_paid_notify')    into v_trg_set;

    raise notice 'mig 110: features=% trg_commission=% trg_biz_approval=% trg_settlement_paid=%',
        v_feature_count, v_trg_comm, v_trg_biz, v_trg_set;

    if v_feature_count <> 2 or not v_trg_comm or not v_trg_biz or not v_trg_set then
        raise exception 'Migration 110 sanity failed';
    end if;
end
$sanity_110$;

commit;

-- =============================================================================
-- End of migration 110
-- =============================================================================
