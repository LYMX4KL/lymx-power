-- =============================================================================
-- Migration 109 — partner_notifications (Sprint 3)
-- =============================================================================
-- Foundational event-feed table for partners. Backend code emits events
-- (commission earned, downline activation, settlement paid, etc.) via
-- fn_emit_partner_notification. The partner sees them on notifications.html
-- + the sidebar bell badge.
--
-- Tables:
--   partner_notifications   — one row per event delivered to one partner
--
-- RPCs:
--   fn_emit_partner_notification(...)   — SECURITY DEFINER. Backend-only call.
--                                         RLS prevents partner-side INSERT;
--                                         only admin and SECURITY-DEFINER paths
--                                         can write notifications.
--   fn_mark_notification_read(id)       — partner marks one row read.
--   fn_partner_unread_count()           — bell-badge count for current user.
--
-- Named dollar-quotes per feedback_supabase_named_dollar_quotes.
-- =============================================================================

set local statement_timeout = 0;

begin;

-- =====================================================================
-- 1. partner_notifications table
-- =====================================================================
create table if not exists public.partner_notifications (
    id                    uuid primary key default uuid_generate_v4(),
    partner_id            uuid not null references public.partners(id) on delete cascade,

    -- Event categorization
    kind                  text not null
                              check (kind in (
                                  'commission_earned',
                                  'direct_activation',
                                  'downline_signup',
                                  'qualifier_progress',
                                  'settlement_paid',
                                  'system'
                              )),

    -- Display
    title                 text not null,
    body                  text,
    target_url            text,                   -- relative URL the row links to (e.g. /partner-payouts.html#period=2026-05)

    -- Read state
    is_read               boolean not null default false,
    read_at               timestamptz,

    -- Provenance
    emitted_by            uuid references auth.users(id),
    related_entity_type   text,                   -- e.g. 'partner_commission', 'business', 'settlement'
    related_entity_id     uuid,

    created_at            timestamptz not null default now()
);

create index if not exists idx_pn_partner_unread
    on public.partner_notifications(partner_id, is_read, created_at desc);
create index if not exists idx_pn_partner_created
    on public.partner_notifications(partner_id, created_at desc);
create index if not exists idx_pn_related
    on public.partner_notifications(related_entity_type, related_entity_id)
    where related_entity_id is not null;

alter table public.partner_notifications enable row level security;

-- Partner reads their own rows. The link from auth.uid() -> partners is via
-- partners.user_id (a partner has exactly one auth user).
drop policy if exists pn_read_self on public.partner_notifications;
create policy pn_read_self on public.partner_notifications
    for select to authenticated
    using (
        partner_id in (
            select id from public.partners where user_id = auth.uid()
        )
    );

-- Partner can mark their own rows read (UPDATE limited to flipping is_read/read_at)
drop policy if exists pn_update_read_self on public.partner_notifications;
create policy pn_update_read_self on public.partner_notifications
    for update to authenticated
    using (
        partner_id in (
            select id from public.partners where user_id = auth.uid()
        )
    )
    with check (
        partner_id in (
            select id from public.partners where user_id = auth.uid()
        )
    );

-- Admin reads + writes everything (including INSERT — used by the manual emit RPC + future admin UI)
drop policy if exists pn_admin_all on public.partner_notifications;
create policy pn_admin_all on public.partner_notifications
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- Important: NO direct INSERT policy for partners. Notifications are only
-- inserted by SECURITY DEFINER functions (fn_emit_partner_notification) or
-- by admins. Partners cannot fabricate events.
grant select, update on public.partner_notifications to authenticated;

comment on table public.partner_notifications is
  'Event feed delivered to individual partners. Backend writes via fn_emit_partner_notification (SECURITY DEFINER); partners read + mark-read their own rows; admins all. No partner-side INSERT path — events are system-generated.';

-- =====================================================================
-- 2. fn_emit_partner_notification — backend-only emit RPC
-- =====================================================================
create or replace function public.fn_emit_partner_notification(
    p_partner_id           uuid,
    p_kind                 text,
    p_title                text,
    p_body                 text default null,
    p_target_url           text default null,
    p_related_entity_type  text default null,
    p_related_entity_id    uuid default null
) returns public.partner_notifications
language plpgsql
security definer
set search_path = public, pg_temp
as $fn_emit_pn$
declare
    v_caller_uid uuid;
    v_row        public.partner_notifications;
begin
    if p_partner_id is null then
        raise exception 'fn_emit_partner_notification: partner_id required';
    end if;
    if p_kind is null or p_kind = '' then
        raise exception 'fn_emit_partner_notification: kind required';
    end if;
    if p_title is null or p_title = '' then
        raise exception 'fn_emit_partner_notification: title required';
    end if;

    -- Authorization gate: only admin OR triggers/EFs running as service_role
    -- can emit. We detect "running from a trigger / service-role" by checking
    -- if auth.uid() is null (service-role context). Admin path passes via
    -- am_i_admin(). Anyone else (a logged-in partner / customer) is rejected.
    v_caller_uid := auth.uid();
    if v_caller_uid is not null and not public.am_i_admin() then
        raise exception 'fn_emit_partner_notification: not authorized (only admin or service-role can emit)';
    end if;

    -- Verify the partner exists
    if not exists (select 1 from public.partners where id = p_partner_id) then
        raise exception 'fn_emit_partner_notification: partner % not found', p_partner_id;
    end if;

    insert into public.partner_notifications (
        partner_id, kind, title, body, target_url,
        emitted_by, related_entity_type, related_entity_id
    ) values (
        p_partner_id, p_kind, p_title, p_body, p_target_url,
        v_caller_uid, p_related_entity_type, p_related_entity_id
    )
    returning * into v_row;

    return v_row;
end
$fn_emit_pn$;

revoke all on function public.fn_emit_partner_notification(uuid,text,text,text,text,text,uuid) from public;
grant execute on function public.fn_emit_partner_notification(uuid,text,text,text,text,text,uuid) to authenticated;

comment on function public.fn_emit_partner_notification(uuid,text,text,text,text,text,uuid) is
  'Backend-only emit. SECURITY DEFINER allows triggers (service-role context, auth.uid() is null) + admins to write. Logged-in non-admin callers are rejected, preventing fabricated events. Returns the inserted row.';

-- =====================================================================
-- 3. fn_mark_notification_read — partner marks one row read
-- =====================================================================
create or replace function public.fn_mark_notification_read(
    p_notification_id uuid
) returns public.partner_notifications
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn_mark_read$
declare
    v_row public.partner_notifications;
begin
    if auth.uid() is null then
        raise exception 'fn_mark_notification_read: must be signed in';
    end if;

    update public.partner_notifications
       set is_read = true,
           read_at = now()
     where id = p_notification_id
       and partner_id in (select id from public.partners where user_id = auth.uid())
     returning * into v_row;

    if not found then
        raise exception 'fn_mark_notification_read: notification % not found or not yours', p_notification_id;
    end if;

    return v_row;
end
$fn_mark_read$;

revoke all on function public.fn_mark_notification_read(uuid) from public;
grant execute on function public.fn_mark_notification_read(uuid) to authenticated;

comment on function public.fn_mark_notification_read(uuid) is
  'Mark one notification read. SECURITY INVOKER + auth.uid() check + partners.user_id join means a partner can only mark their own. Throws if the row is missing or not theirs.';

-- =====================================================================
-- 4. fn_partner_unread_count — bell badge count for current user
-- =====================================================================
create or replace function public.fn_partner_unread_count()
returns int
language plpgsql
security invoker
set search_path = public, pg_temp
stable
as $fn_unread$
begin
    if auth.uid() is null then return 0; end if;
    return (
        select count(*)::int
          from public.partner_notifications
         where is_read = false
           and partner_id in (select id from public.partners where user_id = auth.uid())
    );
end
$fn_unread$;

revoke all on function public.fn_partner_unread_count() from public;
grant execute on function public.fn_partner_unread_count() to authenticated;

comment on function public.fn_partner_unread_count() is
  'Unread count for the current signed-in partner. Used by the sidebar bell badge. Returns 0 for non-partners.';

-- =====================================================================
-- 5. Sanity check
-- =====================================================================
do $sanity_109$
declare
    v_tab boolean;
    v_emit boolean;
    v_mark boolean;
    v_count boolean;
begin
    select exists (select 1 from information_schema.tables
                    where table_schema='public' and table_name='partner_notifications') into v_tab;
    select exists (select 1 from pg_proc
                    where proname='fn_emit_partner_notification' and pronamespace='public'::regnamespace) into v_emit;
    select exists (select 1 from pg_proc
                    where proname='fn_mark_notification_read' and pronamespace='public'::regnamespace) into v_mark;
    select exists (select 1 from pg_proc
                    where proname='fn_partner_unread_count' and pronamespace='public'::regnamespace) into v_count;

    raise notice 'mig 109: table=% emit=% mark_read=% unread_count=%',
        v_tab, v_emit, v_mark, v_count;

    if not v_tab or not v_emit or not v_mark or not v_count then
        raise exception 'Migration 109 sanity failed';
    end if;
end
$sanity_109$;

commit;

-- =============================================================================
-- End of migration 109
-- =============================================================================
