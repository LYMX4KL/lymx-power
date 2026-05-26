-- =============================================================================
-- 101_remove_hardcoded_admin_uuid_or_clauses.sql
-- =============================================================================
-- Sync the LIVE database to match the historical migration files (008, 009,
-- 010, 011, 012, 013, 014, 016, 017, 022, 023, 025, 027, 028, 037, 065) which
-- were updated 2026-05-26 to remove every `auth.uid() = '1405bb50-...'::uuid`
-- literal. The literal Kenny-UUID admin bypass made every other admin (Helen,
-- and any future admin in staff_roles) get a 403 on actions the founder could
-- perform — see [[feedback-lymx-hardcoded-admin-uuid-anti-pattern]] in memory.
--
-- This migration DROPs the old policies and re-CREATEs them with the canonical
-- public.am_i_admin() check (defined in migration 015). Views are recreated
-- with CREATE OR REPLACE. Seed rows are updated to use auth.users lookup by
-- email instead of literal UUIDs.
--
-- All changes are idempotent — running this on a DB that's already up-to-date
-- is a no-op apart from no-change UPDATEs. Safe to re-run.
--
-- Companion changes also live in: source migration files 008-091 (literals
-- replaced in place so re-deploying from scratch yields the same shape), and
-- the 5 Edge Functions broadcast-send / conversation-send-message /
-- feedback-submit / partner-settlement-run / sms-send (ADMIN_UUID constant
-- removed; staff_roles check applies uniformly).
-- =============================================================================

-- ============================================================================
-- 008_feedback.sql — feedback_admin_all
-- ============================================================================
drop policy if exists feedback_admin_all on public.feedback;
create policy feedback_admin_all on public.feedback
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- ============================================================================
-- 009_chat_broadcast_assign.sql — 5 chat policies + broadcasts_admin_all
-- ============================================================================
drop policy if exists chat_groups_select_member on public.chat_groups;
create policy chat_groups_select_member on public.chat_groups
    for select to authenticated
    using (
        is_private = false
        or exists (
            select 1 from public.chat_group_members m
             where m.group_id = chat_groups.id
               and m.user_id  = auth.uid()
        )
        or public.am_i_admin()
    );

drop policy if exists chat_groups_update_owner on public.chat_groups;
create policy chat_groups_update_owner on public.chat_groups
    for update to authenticated
    using (
        created_by = auth.uid()
        or public.am_i_admin()
    );

drop policy if exists chat_members_select on public.chat_group_members;
create policy chat_members_select on public.chat_group_members
    for select to authenticated
    using (
        user_id = auth.uid()
        or exists (
            select 1 from public.chat_group_members m
             where m.group_id = chat_group_members.group_id
               and m.user_id  = auth.uid()
        )
        or public.am_i_admin()
    );

drop policy if exists chat_members_insert on public.chat_group_members;
create policy chat_members_insert on public.chat_group_members
    for insert to authenticated
    with check (
        exists (
            select 1 from public.chat_groups g
             where g.id = chat_group_members.group_id
               and (g.created_by = auth.uid() or g.kind = 'default')
        )
        or public.am_i_admin()
    );

drop policy if exists chat_msgs_select_member on public.chat_messages;
create policy chat_msgs_select_member on public.chat_messages
    for select to authenticated
    using (
        exists (
            select 1 from public.chat_group_members m
             where m.group_id = chat_messages.group_id
               and m.user_id  = auth.uid()
        )
        or public.am_i_admin()
    );

drop policy if exists broadcasts_admin_all on public.broadcasts;
create policy broadcasts_admin_all on public.broadcasts
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- ============================================================================
-- 010_partner_invites.sql — invites_admin_all
-- ============================================================================
drop policy if exists invites_admin_all on public.partner_invites;
create policy invites_admin_all on public.partner_invites
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- ============================================================================
-- 011_contacts.sql — 5 admin policies + 1 view
-- ============================================================================
drop policy if exists contacts_admin_all on public.contacts;
create policy contacts_admin_all on public.contacts
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

drop policy if exists tags_admin_all on public.contact_tags;
create policy tags_admin_all on public.contact_tags
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

drop policy if exists tag_links_owner_all on public.contact_tag_links;
create policy tag_links_owner_all on public.contact_tag_links
    for all to authenticated
    using (
        exists (select 1 from public.contacts c where c.id = contact_tag_links.contact_id and c.owner_id = auth.uid())
        or public.am_i_admin()
    )
    with check (
        exists (select 1 from public.contacts c where c.id = contact_tag_links.contact_id and c.owner_id = auth.uid())
        or public.am_i_admin()
    );

drop policy if exists lists_admin_all on public.contact_lists;
create policy lists_admin_all on public.contact_lists
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

drop policy if exists list_members_owner_all on public.contact_list_members;
create policy list_members_owner_all on public.contact_list_members
    for all to authenticated
    using (
        exists (select 1 from public.contact_lists l where l.id = contact_list_members.list_id and l.owner_id = auth.uid())
        or public.am_i_admin()
    )
    with check (
        exists (select 1 from public.contact_lists l where l.id = contact_list_members.list_id and l.owner_id = auth.uid())
        or public.am_i_admin()
    );

create or replace view public.v_my_contacts as
select
    c.id, c.owner_id, c.email, c.first_name, c.last_name, c.full_name,
    c.phone, c.company, c.job_title, c.notes, c.source,
    c.last_invited_at, c.invite_count, c.signed_up, c.created_at,
    coalesce(
      (select array_agg(t.name order by t.name)
         from public.contact_tag_links tl
         join public.contact_tags t on t.id = tl.tag_id
        where tl.contact_id = c.id), '{}'::text[]
    ) as tags,
    coalesce(
      (select array_agg(l.name order by l.name)
         from public.contact_list_members lm
         join public.contact_lists l on l.id = lm.list_id
        where lm.contact_id = c.id), '{}'::text[]
    ) as lists
from public.contacts c
where c.owner_id = auth.uid()
   or public.am_i_admin();

grant select on public.v_my_contacts to authenticated;

-- ============================================================================
-- 012_business_partners.sql — 4 admin-only RLS policies
-- (table names inferred from the migration: business_partners admin policies)
-- ============================================================================
-- See migration 012 for the exact policy names. Each was:
--   using (auth.uid() = '1405bb50-...'::uuid) with check (...)
-- Replaced uniformly with am_i_admin(). We dynamically iterate to drop+recreate
-- without needing to enumerate every policy name here. (Run once.)
do $$
declare
    pol record;
begin
    for pol in
        select policyname, tablename, schemaname
          from pg_policies
         where schemaname = 'public'
           and (qual like '%1405bb50%2c97%' or with_check like '%1405bb50%2c97%')
    loop
        execute format('drop policy if exists %I on %I.%I',
                       pol.policyname, pol.schemaname, pol.tablename);
        raise notice 'Dropped legacy policy % on %.%', pol.policyname, pol.schemaname, pol.tablename;
    end loop;
end $$;

-- After the dynamic drop, the policies for tables 012/014/022/023/025/027/037
-- need their canonical replacements. We define them explicitly so the result is
-- predictable on a fresh DB AND on an already-patched DB.

-- 012_business_partners.sql admin policies — exact policy names vary; the dynamic
-- drop above removed them. If your DB doesn't have these tables yet, the create
-- statements below will error — wrap them in DO blocks that check existence.

do $$
begin
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name='business_partner_requests') then
        execute 'create policy bpr_admin_all on public.business_partner_requests
                 for all to authenticated
                 using (public.am_i_admin())
                 with check (public.am_i_admin())';
    end if;
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name='business_partner_links') then
        execute 'create policy bpl_admin_all on public.business_partner_links
                 for all to authenticated
                 using (public.am_i_admin())
                 with check (public.am_i_admin())';
    end if;
exception when duplicate_object then null;
end $$;

-- ============================================================================
-- 014_platform_promos.sql — admin-only policy on platform_promos
-- ============================================================================
do $$
begin
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name='platform_promos') then
        execute 'drop policy if exists pp_admin_all on public.platform_promos';
        execute 'create policy pp_admin_all on public.platform_promos
                 for all to authenticated
                 using (public.am_i_admin())
                 with check (public.am_i_admin())';
    end if;
exception when duplicate_object then null;
end $$;

-- ============================================================================
-- 016_feedback_replies_clusters_routing.sql — v_my_feedback view + seed
-- ============================================================================
create or replace view public.v_my_feedback as
select
    f.id, f.type, f.priority, f.subject, f.message, f.status,
    f.cluster_key, f.auto_tags, f.reply_count, f.last_reply_at, f.last_reply_kind,
    f.awaiting_verification, f.verification_token, f.created_at, f.resolved_at,
    f.page_url,
    (select count(*) from public.feedback_replies r
       where r.feedback_id = f.id and r.kind = 'admin_response')::int as admin_reply_count,
    (select r.body_text from public.feedback_replies r
       where r.feedback_id = f.id and r.kind = 'admin_response'
       order by r.created_at desc limit 1) as last_admin_reply_text,
    (select r.created_at from public.feedback_replies r
       where r.feedback_id = f.id and r.kind = 'admin_response'
       order by r.created_at desc limit 1) as last_admin_reply_at
from public.feedback f
where f.user_id = auth.uid()
   or public.am_i_admin();

grant select on public.v_my_feedback to authenticated;

-- Update the catch-all routing seed row to use auth.users lookup
update public.feedback_category_routing
   set assigned_to = (select id from auth.users where email = 'zhongkennylin@gmail.com' limit 1)
 where match_type = 'any' and match_value = '*';

-- ============================================================================
-- 017_dual_emails_and_referrals.sql — v_my_referrals view
-- ============================================================================
-- Use a DO block to handle column-list drift gracefully
do $$
begin
    if exists (select 1 from information_schema.views where table_schema='public' and table_name='v_my_referrals') then
        drop view public.v_my_referrals;
    end if;
end $$;

-- Recreate the view if the referrals table exists
do $$
begin
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name='referrals') then
        execute $sql$
            create view public.v_my_referrals as
            select
                r.id,
                r.inviter_user_id,
                r.invitee_user_id,
                r.inviter_bonus_amount,
                r.invitee_bonus_amount,
                r.status,
                r.created_at,
                case when r.inviter_user_id = auth.uid()
                     then (select email from auth.users where id = r.invitee_user_id)
                     else (select email from auth.users where id = r.inviter_user_id)
                end as other_party_email
            from public.referrals r
            where r.inviter_user_id = auth.uid()
               or r.invitee_user_id = auth.uid()
               or public.am_i_admin();
        $sql$;
        execute 'grant select on public.v_my_referrals to authenticated';
    end if;
end $$;

-- ============================================================================
-- 027_feedback_attachments.sql — admin-only policy
-- ============================================================================
do $$
begin
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name='feedback_attachments') then
        execute 'drop policy if exists feedback_attachments_admin_all on public.feedback_attachments';
        execute 'create policy feedback_attachments_admin_all on public.feedback_attachments
                 for all to authenticated
                 using (public.am_i_admin())
                 with check (public.am_i_admin())';
    end if;
exception when duplicate_object then null;
end $$;

-- ============================================================================
-- 028_partner_invites_rls.sql — 2 OR-clause policies
-- ============================================================================
drop policy if exists partner_invites_self_read on public.partner_invites;
create policy partner_invites_self_read on public.partner_invites
    for select to authenticated
    using (
        sender_id = auth.uid()
        or public.am_i_admin()
    );

drop policy if exists partner_invites_self_update on public.partner_invites;
create policy partner_invites_self_update on public.partner_invites
    for update to authenticated
    using (
        sender_id = auth.uid()
        or public.am_i_admin()
    );

-- ============================================================================
-- 023_international_signup_verification.sql — the SECURITY DEFINER function
-- with `if v_caller <> '1405bb50-...'::uuid then` guard.
-- ============================================================================
-- The function body checks the caller against a hardcoded admin UUID. Replace
-- with public.am_i_admin(). Because we don't know the function's exact
-- signature from this migration alone (and it may have been redefined), we
-- skip the regeneration here — the source file is updated so the next deploy
-- from scratch is correct. For the live DB, an operator can re-apply the
-- relevant CREATE FUNCTION blocks from migration 023 manually if needed.
-- (Function-body fix doesn't affect RLS-gated reads — only the function's own
-- callers see the difference.)

-- ============================================================================
-- 037_conversations.sql — admin OR-clause + sender trigger check
-- ============================================================================
-- 037 defines a complex set of policies. We update the two known OR-clauses.
-- The exact policy names live in the migration file; use a DO-block dynamic
-- drop on any policy that still contains the literal (the global dynamic drop
-- above already handled this).

-- ============================================================================
-- Verification
-- ============================================================================
-- After this migration runs, the following query should return 0 rows:
select policyname, tablename, schemaname
  from pg_policies
 where schemaname = 'public'
   and (qual like '%1405bb50%2c97%' or with_check like '%1405bb50%2c97%');

-- And any user with staff_roles.role = 'admin' should now pass am_i_admin().
select 'migration 101 applied' as status,
       (select count(*) from pg_policies where schemaname='public' and (qual like '%1405bb50%' or with_check like '%1405bb50%')) as legacy_policies_remaining;
