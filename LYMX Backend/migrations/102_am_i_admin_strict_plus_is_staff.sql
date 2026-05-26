-- =============================================================================
-- Migration 102 — Restore strict am_i_admin() + introduce is_staff() helper +
--                 fix every call site that was silently relying on the broken
--                 over-permissive am_i_admin() to grant any-staff access.
-- =============================================================================
-- Background:
--   Migrations 025 (line 43) and 037 (line 257) BOTH redefined public.am_i_admin()
--   so it returned TRUE for any row in public.staff_roles, regardless of role.
--   The 037 variant even called am_i_admin() inside its own COALESCE fallback,
--   producing infinite recursion under certain auth contexts.
--   Real-world symptom: Rachel (marketing) saw every other user's feedback in
--   v_my_feedback because am_i_admin() returned true for her.
--
--   See: AM_I_ADMIN_AUDIT.md (130 call-sites surveyed; this migration acts on
--   the D/C/E/F-class sites + the F items Kenny resolved on 2026-05-26).
--
-- This migration:
--   1. Restores public.am_i_admin() to the canonical strict role='admin' check
--      from migration 015. Uses SECURITY DEFINER + search_path per the
--      ARCHITECTURE-RULES.md cross-schema-parse-context guidance.
--   2. Adds public.is_staff() — true for ANY staff_roles row.
--   3. Updates the 38 D-class sites that need "any staff" (conversations, chat,
--      v_my_feedback assignee branch, fb attachments triage, etc).
--   4. Updates the 4 C-class sites (finance) to OR am_i_cfo().
--   5. Updates E-class sites (reviews→support; marketing posts→marketing;
--      v_team_roster→am_i_hr_or_admin per Kenny's F#7 ruling).
--   6. F-class items per Kenny's 2026-05-26 directives:
--        F#1 (034 bookings)   → admin OR host-self
--        F#2 (035 biz read)   → STRICT admin only
--        F#3 (040 leads/bk)   → STRICT admin only
--        F#4 (048 fraud)      → STRICT admin only
--        F#5 (078 biz_docs)   → STRICT admin only
--        F#6 (085 reservations) → admin OR biz_owner (already correct — no change)
--        F#7 (087 v_team_roster) → am_i_hr_or_admin()
--        F#8 (096 onboarding audit) → STRICT admin only
--   7. fn_claim_conversation gate widened to is_staff() so Rachel/Dave can
--      claim from the unified inbox.
--   8. v_my_feedback gains `f.assigned_to = auth.uid()` so triagers see what
--      they were routed (column name is `assigned_to`, defined in
--      migration 016 line 143 — NOT `assignee_user_id` as some specs called it).
--
-- DOES NOT TOUCH:
--   * tx_no_customer_transfers (048:104) — strict admin is the CRITICAL
--     fraud gate. Per FRAUD-PREVENTION-SUMMARY.md. Leave alone.
--   * staff_roles_admin_all (015:67) — strict admin is non-negotiable
--     (self-promotion vector if loosened).
--   * Any A-class site listed in the audit.
--   * Migrations 025/047/049/055/084 — they already OR am_i_hr()/am_i_cfo(),
--     which automatically carry admins through once strict admin is restored.
--
-- TODO Kenny:
--   * NONE outstanding for this migration. All 8 F-class items have explicit
--     directives. Verify after deploy that Rachel still sees conversations
--     (via is_staff()) and that Susan (marketing) can write marketing_posts.
--
-- Idempotent. Named dollar-quotes per feedback_supabase_named_dollar_quotes.
-- =============================================================================

set local statement_timeout = 0;


-- ============================================================================
-- 1. RESTORE STRICT am_i_admin() — overrides the bad redefinitions in 025+037
-- ============================================================================
-- Strict definition from migration 015. SECURITY DEFINER + explicit search_path
-- so the function is safe to call from policy contexts where the caller's
-- search_path may not include public (per migration 065 comment).
create or replace function public.am_i_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $am_i_admin$
    select exists (
        select 1
          from public.staff_roles
         where user_id = auth.uid()
           and role    = 'admin'
    )
$am_i_admin$;

grant execute on function public.am_i_admin() to authenticated, anon;


-- ============================================================================
-- 2. NEW HELPER — public.is_staff()
-- ============================================================================
-- Returns true for ANY staff_roles row, regardless of role. This is the
-- helper the broken am_i_admin() redefinition was *trying* to be. With this
-- in place, the 38 D-class call sites get a clean any-staff check.
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $is_staff$
    select exists (
        select 1
          from public.staff_roles
         where user_id = auth.uid()
    )
$is_staff$;

grant execute on function public.is_staff() to authenticated;


-- ============================================================================
-- 3. CONVERSATIONS — any staff can read/handle/claim (migration 037)
-- ============================================================================
-- Audit class D for all conv_* policies. Rachel (marketing) and Dave (support
-- in the future) need to triage from the unified inbox. is_staff() is the
-- correct intent gate.

drop policy if exists conv_admin_all on public.conversations;
create policy conv_admin_all on public.conversations
    for all to authenticated
    using       (public.is_staff() or public.am_i_admin())
    with check  (public.is_staff() or public.am_i_admin());

drop policy if exists conv_msg_admin_all on public.conversation_messages;
create policy conv_msg_admin_all on public.conversation_messages
    for all to authenticated
    using       (public.is_staff() or public.am_i_admin())
    with check  (public.is_staff() or public.am_i_admin());

drop policy if exists conv_part_admin_all on public.conversation_participants;
create policy conv_part_admin_all on public.conversation_participants
    for all to authenticated
    using       (public.is_staff() or public.am_i_admin())
    with check  (public.is_staff() or public.am_i_admin());

drop policy if exists conv_att_admin_all on public.conversation_attachments;
create policy conv_att_admin_all on public.conversation_attachments
    for all to authenticated
    using       (public.is_staff() or public.am_i_admin())
    with check  (public.is_staff() or public.am_i_admin());

-- Participant-or-staff read for conversation attachments (replaces the
-- am_i_admin()-only OR branch inside conv_att_participant_read at 037:431).
drop policy if exists conv_att_participant_read on public.conversation_attachments;
create policy conv_att_participant_read on public.conversation_attachments
    for select to authenticated
    using (
        exists (
            select 1
              from public.conversation_messages m
              join public.conversations         c on c.id = m.conversation_id
             where m.id = conversation_attachments.message_id
               and (
                       public.is_staff()
                    or public.am_i_admin()
                    or exists (
                        select 1
                          from public.conversation_participants cp
                         where cp.conversation_id = c.id
                           and cp.user_id         = auth.uid()
                    )
               )
        )
    );


-- ============================================================================
-- 4. fn_claim_conversation — widen gate from admin-only to is_staff()
-- ============================================================================
-- 037:552 originally raised "only admins can claim conversations". With
-- the broken am_i_admin() this silently let Rachel through. After restoring
-- strict admin she'd be locked out of the inbox. Per AUDIT 4.1, widen to
-- is_staff() so ANY staff_roles member (marketing/support/sales/etc) can
-- claim. Function signature preserved exactly so existing JS callers work.
create or replace function public.fn_claim_conversation(
    p_conversation_id uuid,
    p_staleness_hours int default 4
)
returns table (
    claimed             boolean,
    previous_assignee   uuid,
    new_assignee        uuid,
    last_handled_at_was timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn_claim$
declare
    v_now           timestamptz := now();
    v_caller        uuid := auth.uid();
    v_can_claim     boolean;
    v_prev          uuid;
    v_last_handled  timestamptz;
begin
    if v_caller is null then
        raise exception 'claim requires authentication';
    end if;

    -- 2026-05-26 (migration 102): widened from am_i_admin() to is_staff() so
    -- the unified inbox is workable by Rachel/Dave/etc., not just full admins.
    v_can_claim := public.is_staff() or public.am_i_admin();
    if not v_can_claim then
        raise exception 'only staff can claim conversations';
    end if;

    select assigned_to_user_id, last_handled_at
      into v_prev, v_last_handled
      from public.conversations
     where id = p_conversation_id;

    if not found then
        raise exception 'conversation % not found', p_conversation_id;
    end if;

    -- Allowed to claim if: unassigned, already-yours, or stale.
    if v_prev is null
       or v_prev = v_caller
       or v_last_handled is null
       or v_last_handled < v_now - make_interval(hours => p_staleness_hours) then
        update public.conversations
           set assigned_to_user_id     = v_caller,
               last_handled_by_user_id = v_caller,
               last_handled_at         = v_now,
               updated_at              = v_now
         where id = p_conversation_id;

        return query select true, v_prev, v_caller, v_last_handled;
    else
        return query select false, v_prev, v_prev, v_last_handled;
    end if;
end;
$fn_claim$;

grant execute on function public.fn_claim_conversation(uuid, int) to authenticated;


-- ============================================================================
-- 5. fn_can_read_conversation — widen from am_i_admin() to is_staff()
-- ============================================================================
-- 071:117. Same logic as conv_* policies. Staff can read any conversation
-- they need to triage; non-staff still gated to subject/participant.
create or replace function public.fn_can_read_conversation(p_conv_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $fn_can_read$
    select
        public.is_staff()
        or public.am_i_admin()
        or public.fn_is_subject_of_conversation(p_conv_id)
        or public.fn_is_participant_of_conversation(p_conv_id);
$fn_can_read$;

grant execute on function public.fn_can_read_conversation(uuid) to authenticated;


-- ============================================================================
-- 6. CHAT (migration 009) — any staff can read chat groups + messages + members
-- ============================================================================
-- Audit D for select policies. Internal team chat — every staff member needs
-- visibility. Insert/update for groups stays admin-only (A-class).

-- 009:149 chat_groups select — preserve is_private=false branch, swap admin to is_staff
drop policy if exists chat_groups_select_member on public.chat_groups;
create policy chat_groups_select_member on public.chat_groups
    for select to authenticated
    using (
        is_private = false
        or exists (
            select 1
              from public.chat_group_members m
             where m.group_id = chat_groups.id
               and m.user_id  = auth.uid()
        )
        or public.is_staff()
        or public.am_i_admin()
    );

-- 009:182 chat_group_members select
drop policy if exists chat_members_select on public.chat_group_members;
create policy chat_members_select on public.chat_group_members
    for select to authenticated
    using (
        user_id = auth.uid()
        or exists (
            select 1
              from public.chat_group_members m
             where m.group_id = chat_group_members.group_id
               and m.user_id  = auth.uid()
        )
        or public.is_staff()
        or public.am_i_admin()
    );

-- 009:216 chat_messages select
drop policy if exists chat_msgs_select_member on public.chat_messages;
create policy chat_msgs_select_member on public.chat_messages
    for select to authenticated
    using (
        exists (
            select 1
              from public.chat_group_members m
             where m.group_id = chat_messages.group_id
               and m.user_id  = auth.uid()
        )
        or public.is_staff()
        or public.am_i_admin()
    );

-- INTENTIONALLY NOT TOUCHED (A-class):
--   chat_groups_update_owner (009:172) — only group-creator OR admin
--   chat_members_insert     (009:196) — only group-owner OR admin


-- ============================================================================
-- 7. BROADCASTS (009:250 + 051:15) — admin + CFO only (C-class, finance gate)
-- ============================================================================
-- Broadcasts cost real money (SMS, email blasts). Per AUDIT 4.6, marketing
-- must route through change_requests. Recreate the policy at the canonical
-- 051 location.
drop policy if exists broadcasts_admin_all on public.broadcasts;
create policy broadcasts_admin_all on public.broadcasts
    for all to authenticated
    using       (public.am_i_admin() or public.am_i_cfo())
    with check  (public.am_i_admin() or public.am_i_cfo());


-- ============================================================================
-- 8. FEEDBACK (008, 016, 027) — support/tech triage + assignee branch on view
-- ============================================================================
-- Per audit, feedback_admin_all + fb_replies_admin_all + fb_att_admin_all
-- need to extend to support/tech (D-class with finer-grained routing).
-- v_my_feedback also gets the assigned-to branch so Rachel's per-role-tester
-- assignments still surface (memory: feedback_lymx_tester_role_routing).

drop policy if exists feedback_admin_all on public.feedback;
create policy feedback_admin_all on public.feedback
    for all to authenticated
    using (
        public.am_i_admin()
        or public.has_staff_role('support')
        or public.has_staff_role('tech')
    )
    with check (
        public.am_i_admin()
        or public.has_staff_role('support')
        or public.has_staff_role('tech')
    );

drop policy if exists fb_replies_admin_all on public.feedback_replies;
create policy fb_replies_admin_all on public.feedback_replies
    for all to authenticated
    using (
        public.am_i_admin()
        or public.has_staff_role('support')
        or public.has_staff_role('tech')
    )
    with check (
        public.am_i_admin()
        or public.has_staff_role('support')
        or public.has_staff_role('tech')
    );

drop policy if exists fb_att_admin_all on public.feedback_attachments;
create policy fb_att_admin_all on public.feedback_attachments
    for all to authenticated
    using (
        public.am_i_admin()
        or public.has_staff_role('support')
        or public.has_staff_role('tech')
    )
    with check (
        public.am_i_admin()
        or public.has_staff_role('support')
        or public.has_staff_role('tech')
    );

-- v_my_feedback — preserve the explicit column list from 016:247 and add
-- the assigned_to branch. NOTE: the column is `assigned_to`, defined in
-- migration 016 line 143. The audit doc mentioned `assignee_user_id` but
-- that column does not exist on public.feedback.
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
where f.user_id     = auth.uid()
   or f.assigned_to = auth.uid()        -- 2026-05-26 migration 102: triagers see assigned items
   or public.am_i_admin();

grant select on public.v_my_feedback to authenticated;


-- ============================================================================
-- 9. REVIEWS (031) — support reads triage queue, admin verifies (E-class)
-- ============================================================================
drop policy if exists reviews_admin_read on public.reviews;
create policy reviews_admin_read on public.reviews
    for select to authenticated
    using (
        public.am_i_admin()
        or public.has_staff_role('support')
        or public.has_staff_role('tech')
    );

-- INTENTIONALLY NOT TOUCHED (A-class):
--   reviews_admin_verify (031:147) — the LYMX-issuance flip is admin-only
--   on purpose (matches operator-configurable + transaction-finance posture).

-- review-receipts storage bucket — support triages receipt uploads
drop policy if exists review_receipts_admin_read on storage.objects;
create policy review_receipts_admin_read on storage.objects
    for select to authenticated
    using (
        bucket_id = 'review-receipts'
        and (
            public.am_i_admin()
            or public.has_staff_role('support')
        )
    );


-- ============================================================================
-- 10. FINANCE-SENSITIVE SITES (022, 012, 036) — add am_i_cfo() OR
-- ============================================================================
-- C-class. SES + Twilio + Stripe-webhook + biz billing all sit at the
-- cost/finance boundary. Strict admin alone would lock CFO out of audit.

-- 022:54 email_sends_admin_all (preserves sender_user_id self-read)
drop policy if exists email_sends_admin_all on public.email_sends;
create policy email_sends_admin_all on public.email_sends
    for select to authenticated
    using (
        public.am_i_admin()
        or public.am_i_cfo()
        or sender_user_id = auth.uid()
    );

-- 022:90 email_events_admin_all (CFO + admin + sender via FK)
drop policy if exists email_events_admin_all on public.email_events;
create policy email_events_admin_all on public.email_events
    for select to authenticated
    using (
        public.am_i_admin()
        or public.am_i_cfo()
        or exists (
            select 1
              from public.email_sends s
             where s.id              = email_events.email_send_id
               and s.sender_user_id  = auth.uid()
        )
    );

-- 022:190 sms_messages_admin_all (CFO + admin + sender + recipient self)
drop policy if exists sms_messages_admin_all on public.sms_messages;
create policy sms_messages_admin_all on public.sms_messages
    for select to authenticated
    using (
        public.am_i_admin()
        or public.am_i_cfo()
        or sender_user_id    = auth.uid()
        or recipient_user_id = auth.uid()
    );

-- 012:334 business_billing
drop policy if exists billing_admin_all on public.business_billing;
create policy billing_admin_all on public.business_billing
    for all to authenticated
    using       (public.am_i_admin() or public.am_i_cfo())
    with check  (public.am_i_admin() or public.am_i_cfo());

-- 036:50 stripe_webhook_events
drop policy if exists stripe_webhook_admin on public.stripe_webhook_events;
create policy stripe_webhook_admin on public.stripe_webhook_events
    for select to authenticated
    using (public.am_i_admin() or public.am_i_cfo());


-- ============================================================================
-- 11. MARKETING POSTS (079) — marketing team writes (E-class)
-- ============================================================================
-- Susan (marketing) needs to edit drafts. Published posts stay public-read.
drop policy if exists marketing_posts_public_read on public.marketing_posts;
create policy marketing_posts_public_read on public.marketing_posts
    for select to authenticated
    using (
        published = true
        or public.am_i_admin()
        or public.has_staff_role('marketing')
    );

drop policy if exists marketing_posts_admin_write on public.marketing_posts;
create policy marketing_posts_admin_write on public.marketing_posts
    for all to authenticated
    using       (public.am_i_admin() or public.has_staff_role('marketing'))
    with check  (public.am_i_admin() or public.has_staff_role('marketing'));


-- ============================================================================
-- 12. TEAM ROSTER VIEW (087) — HR/Compliance sees it too (E-class, F#7)
-- ============================================================================
-- Kenny's F#7 directive: am_i_hr_or_admin(). Helper exists in migration 055.
-- Recreate the view preserving the EXACT column list from 087:30-58 so
-- frontend consumers (admin-timesheets.html) don't break.
drop view if exists public.v_team_roster cascade;

create or replace view public.v_team_roster as
select
    u.id                                                              as user_id,
    u.email,
    coalesce(
        nullif(trim(sp.title), ''),
        nullif(trim(sr.job_title), ''),
        split_part(u.email, '@', 1)
    )                                                                 as display_name,
    coalesce(sr.job_title, sr.role)                                   as job_title,
    sr.role,
    sr.is_cfo,
    sr.is_hr,
    sr.employment_type,
    sr.hire_date,
    sr.remote_allowed,
    sr.geofence_radius_m,
    (sr.home_office_lat is not null)                                  as has_anchor,
    (
        select max(event_at)
          from public.clock_events ce
         where ce.user_id = u.id
           and ce.event_type = 'in'
    )                                                                 as last_clock_in
  from auth.users u
  join public.staff_roles sr     on sr.user_id = u.id
  left join public.staff_profiles sp on sp.user_id = u.id
 where public.am_i_hr_or_admin()        -- 2026-05-26 mig 102: widen from am_i_admin()
 order by sr.role, u.email;

-- IMPORTANT: do NOT set security_invoker = on. Definer mode is required so
-- the view can read auth.users (mig 087 documented this rationale).
grant select on public.v_team_roster to authenticated;


-- ============================================================================
-- 13. ONBOARDING BOOKINGS (034) — admin OR host-self (F#1, Kenny ruling)
-- ============================================================================
-- 034:121. The host_id column refs public.onboarding_hosts.id. Host's
-- auth.users.id is stored in onboarding_hosts.user_id. The existing policy
-- already includes that subquery — we keep the SAME predicate and JUST
-- replace the literal am_i_admin() call so nothing widens beyond Kenny's
-- F#1 directive (admin + host-self only, no sales/marketing widening).
drop policy if exists bookings_admin_all on public.onboarding_bookings;
create policy bookings_admin_all on public.onboarding_bookings
    for all to authenticated
    using (
        public.am_i_admin()
        or host_id in (
            select id
              from public.onboarding_hosts
             where user_id = auth.uid()
        )
    )
    with check (
        public.am_i_admin()
        or host_id in (
            select id
              from public.onboarding_hosts
             where user_id = auth.uid()
        )
    );

-- INTENTIONALLY NOT TOUCHED (A-class on 034):
--   hosts_admin_write       — admin only
--   availability_admin_write — admin only


-- ============================================================================
-- 14. BUSINESSES APPROVAL READ (035) — STRICT admin only (F#2 ruling)
-- ============================================================================
-- 035:160 businesses_admin_read. Kenny picked "admin only" — no support/sales
-- widening. Recreate with strict am_i_admin() so the now-strict helper
-- propagates through the policy.
drop policy if exists businesses_admin_read on public.businesses;
create policy businesses_admin_read on public.businesses
    for select to authenticated
    using (public.am_i_admin());

-- INTENTIONALLY NOT TOUCHED:
--   businesses_admin_update (035:165) — admin only (A-class)


-- ============================================================================
-- 15. LEADS + TEAM-CALENDAR BOOKINGS (040) — STRICT admin only (F#3 ruling)
-- ============================================================================
-- Kenny F#3: admin only. Sales/marketing don't get blanket read on leads
-- until a real ask comes in. Recreate so strict admin flows through.
drop policy if exists leads_admin_all on public.leads;
create policy leads_admin_all on public.leads
    for all to authenticated
    using       (public.am_i_admin())
    with check  (public.am_i_admin());

drop policy if exists bookings_admin_all on public.bookings;
create policy bookings_admin_all on public.bookings
    for all to authenticated
    using       (public.am_i_admin())
    with check  (public.am_i_admin());

-- INTENTIONALLY NOT TOUCHED:
--   tc_admin_all (040:241) on team_calendars — A-class, admin only


-- ============================================================================
-- 16. FRAUD FLAGS (048) — STRICT admin only (F#4 ruling)
-- ============================================================================
-- Kenny F#4: admin only. No compliance widening today.
drop policy if exists ff_admin_read on public.fraud_flags;
create policy ff_admin_read on public.fraud_flags
    for select to authenticated
    using (public.am_i_admin());

drop policy if exists ff_admin_write on public.fraud_flags;
create policy ff_admin_write on public.fraud_flags
    for all to authenticated
    using       (public.am_i_admin())
    with check  (public.am_i_admin());

-- INTENTIONALLY NOT TOUCHED:
--   tx_no_customer_transfers (048:104) — CRITICAL fraud gate. Strict admin
--   is the entire point. Do NOT loosen. (Audit class A.)


-- ============================================================================
-- 17. BUSINESS DOCUMENTS (078) — STRICT admin only (F#5 ruling)
-- ============================================================================
-- Kenny F#5: admin only. No support/compliance widening. Recreate the
-- table-policy + the two storage-bucket policies preserving the existing
-- biz-owner OR branch (which is intentional, not part of the band-aid).
drop policy if exists biz_docs_admin_all on public.business_documents;
create policy biz_docs_admin_all on public.business_documents
    for all to authenticated
    using       (public.am_i_admin())
    with check  (public.am_i_admin());

drop policy if exists biz_docs_storage_read on storage.objects;
create policy biz_docs_storage_read on storage.objects
    for select to authenticated
    using (
        bucket_id = 'business-documents'
        and (
            public.am_i_admin()
            or exists (
                select 1
                  from public.businesses b
                 where b.id::text       = split_part(name, '/', 1)
                   and b.owner_user_id  = auth.uid()
            )
        )
    );

drop policy if exists biz_docs_storage_write on storage.objects;
create policy biz_docs_storage_write on storage.objects
    for insert to authenticated
    with check (
        bucket_id = 'business-documents'
        and (
            public.am_i_admin()
            or exists (
                select 1
                  from public.businesses b
                 where b.id::text       = split_part(name, '/', 1)
                   and b.owner_user_id  = auth.uid()
            )
        )
    );


-- ============================================================================
-- 18. TABLE RESERVATIONS (085) — admin OR biz-owner (F#6 ruling)
-- ============================================================================
-- 085:80 tr_read_own already matches Kenny's F#6 directive exactly:
--   user_id = auth.uid() OR am_i_admin() OR biz.owner_user_id check
-- No widening needed. Recreated here ONLY so the now-strict am_i_admin()
-- is the predicate flowing through — equivalent semantically, but the
-- explicit recreate makes the audit trail clear.
drop policy if exists tr_read_own on public.table_reservations;
create policy tr_read_own on public.table_reservations
    for select to authenticated
    using (
        user_id = auth.uid()
        or public.am_i_admin()
        or exists (
            select 1
              from public.businesses b
             where b.id              = table_reservations.business_id
               and b.owner_user_id   = auth.uid()
        )
    );

-- INTENTIONALLY NOT TOUCHED:
--   tr_biz_owner_update + tr_user_cancel_self + event_rsvps policies —
--   all A-class, biz-owner-scoped, admin override is correct as-is.


-- ============================================================================
-- 19. ONBOARDING FOLLOWUP SENDS (096) — STRICT admin only (F#8 ruling)
-- ============================================================================
-- Kenny F#8: audit table, admin only. No sales/marketing read.
drop policy if exists onboarding_followup_sends_admin_all on public.onboarding_followup_sends;
create policy onboarding_followup_sends_admin_all on public.onboarding_followup_sends
    for all to authenticated
    using       (public.am_i_admin())
    with check  (public.am_i_admin());


-- ============================================================================
-- 20. SECTIONS LEFT UNTOUCHED (already-correct sites — strict admin restore
--     simply propagates correctly through the existing OR chains)
-- ============================================================================
--
-- The following A-class sites do NOT need any policy rewrite. Once the
-- strict am_i_admin() lands above, each of these continues to behave
-- correctly because their predicate already uses the right helper:
--
--   * 010 invites_admin_all                      (admin only — correct)
--   * 011 contacts_admin_all / tags / lists      (admin only — correct)
--   * 012 b2b_admin_all / issuances / attribs    (admin only — correct)
--   * 014 promos_admin_all                       (admin only — correct)
--   * 015 staff_roles_admin_all                  (CRITICAL: do not loosen)
--   * 015 change_requests_admin_all              (admin only — correct)
--   * 015 approve/reject_change_request guards   (admin only — correct)
--   * 016 fb_clusters_admin_all / fb_routing     (admin only — correct)
--   * 017 referrals_admin_all / v_my_referrals   (admin only — correct)
--   * 023 *_admin_read_unverified                (admin only — correct)
--   * 025/047/049 HR sites (all OR am_i_hr())    (HR carries through — correct)
--   * 026 pp_admin_all                           (admin only — correct)
--   * 028 partner_invites_select/update          (admin only — correct)
--   * 041 oauth_admin_all                        (admin only — correct)
--   * 048 tx_no_customer_transfers               (CRITICAL fraud gate)
--   * 049 bot_admin_all (OR am_i_hr())           (HR carries through — correct)
--   * 055 benefits_policy_write (OR cfo)         (correct)
--   * 065 can_read_feedback_storage()            (correct, uses sibling pattern)
--   * 075 reserved_partner_codes                 (admin only — correct)
--   * 086 event_rsvps fixes                      (admin only — correct)
--   * 088 qr_scan_issue_redeem                   (admin only — correct)
--   * 090 biz_loc_admin_all                      (admin only — correct)
--   * 091 v_my_lymx_balance                      (admin only — correct)
--   * 093 biz_invitations_admin_all              (admin only — correct)
--   * 101 hardcoded-uuid removal                  (mig 102 supersedes per audit)
--
-- =============================================================================


-- ============================================================================
-- 21. VERIFICATION DO BLOCK
-- ============================================================================
-- Postgres DO blocks don't have an auth.uid() the way RLS does, so we can't
-- emulate Rachel/Kenny via the helpers themselves. Instead we verify the
-- underlying predicate (staff_roles row + role='admin') for each user_id and
-- raise if the seed doesn't match the intent.
do $verify_102$
declare
    v_kenny_uid       uuid := '1405bb50-2c97-48dd-bfa5-31f32320de9b';
    v_rachel_uid      uuid := '2d32a692-5739-47d6-b7eb-43b5c3202b5e';
    v_is_admin_kenny  boolean;
    v_is_admin_rachel boolean;
    v_is_staff_kenny  boolean;
    v_is_staff_rachel boolean;
begin
    -- auth.uid() in a DO block is whatever the calling session is. We can't
    -- impersonate, so we check the predicates by hand against staff_roles.

    select exists (
        select 1 from public.staff_roles
         where user_id = v_kenny_uid and role = 'admin'
    ) into v_is_admin_kenny;

    select exists (
        select 1 from public.staff_roles
         where user_id = v_rachel_uid and role = 'admin'
    ) into v_is_admin_rachel;

    select exists (
        select 1 from public.staff_roles
         where user_id = v_kenny_uid
    ) into v_is_staff_kenny;

    select exists (
        select 1 from public.staff_roles
         where user_id = v_rachel_uid
    ) into v_is_staff_rachel;

    if not v_is_admin_kenny then
        raise exception '102 verify: Kenny should resolve as admin but does not (expected staff_roles.role=admin row)';
    end if;
    if v_is_admin_rachel then
        raise exception '102 verify: Rachel should NOT resolve as admin (her role is marketing) — fix the migration';
    end if;
    if not v_is_staff_kenny then
        raise exception '102 verify: Kenny should resolve as staff (he is admin)';
    end if;
    if not v_is_staff_rachel then
        raise exception '102 verify: Rachel should resolve as staff (she has a staff_roles row)';
    end if;

    raise notice '102 verify: predicates resolve correctly — Kenny=admin+staff, Rachel=staff but not admin';
end $verify_102$;


-- ============================================================================
-- 22. FINAL SUMMARY
-- ============================================================================
do $final$
declare
    v_helper_count int;
begin
    select count(*) into v_helper_count
      from pg_proc
     where proname in (
           'am_i_admin','is_staff','am_i_hr','am_i_cfo','am_i_compliance',
           'am_i_accounting','am_i_admin_onsite','am_i_hr_or_admin','has_staff_role'
     );
    raise notice 'Migration 102 applied — % role/helper functions present (expect >= 9)', v_helper_count;
end$final$;

-- =============================================================================
-- END migration 102
-- =============================================================================
