-- =============================================================================
-- LYMX Power — Migration 071: Conversations RLS infinite-recursion fix
-- =============================================================================
-- Root cause for ticket #f99eef4c "Unable to Send New Message to LYMX Support"
-- (Dave, urgent, in_progress since 2026-05-19):
--
-- PostgreSQL detected infinite recursion between three RLS policies in
-- migration 037_conversations.sql:
--
--   1. conversations.conv_participant_read   SELECTs FROM conversation_participants
--   2. conversation_participants.conv_part_subject_read   SELECTs FROM conversations
--   3. conversation_messages.conv_msg_participant_read   SELECTs FROM conversations
--                                                       AND conversation_participants
--
-- Every read/write on any of the three tables triggered the cycle and
-- Postgres returned 42P17: "infinite recursion detected in policy for
-- relation conversations". The conversation-send-message Edge Function
-- failed with a 500, the my-conversations.html "Send" button received an
-- empty error body, and the user saw "nothing happens" — Dave's exact
-- complaint.
--
-- Audit confirmation (from a live REST GET on /rest/v1/conversations):
--   { "code": "42P17", "message": "infinite recursion detected in policy
--     for relation \"conversations\"" }
--
-- This affected EVERY user, including admin (am_i_admin bypasses one
-- policy but Postgres still planner-evaluates all permissive policies, so
-- the cycle fires regardless of role).
--
-- Fix (root-cause): replace the cross-table EXISTS checks inside RLS
-- policies with SECURITY DEFINER helper functions. The functions run as
-- their owner (the migration runner / postgres role) and bypass RLS on
-- the inner queries, so no cycle ever forms. auth.uid() is still
-- resolved per session, so per-user access control is preserved.
--
-- Three helpers are introduced:
--   * fn_is_subject_of_conversation(uuid)   — am I the customer/business/
--                                              partner subject on this thread?
--   * fn_is_participant_of_conversation(uuid) — am I in conversation_participants?
--   * fn_can_read_conversation(uuid)        — admin OR subject OR participant
--
-- The four affected policies are rebuilt to call these helpers instead of
-- cross-querying the related tables directly.
--
-- Pairs with the no-band-aid rule [[kenny-no-bandaid-fixes]]: the original
-- May 20 patch on #f99eef4c (auto-create customers row on send) addressed
-- only a sub-case (users with no role row). It did not touch the RLS
-- cycle. This migration is the actual cause-level fix.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Helper: fn_is_subject_of_conversation
-- -----------------------------------------------------------------------------
create or replace function public.fn_is_subject_of_conversation(p_conv_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $fn_is_subject$
    select exists (
        select 1
          from public.conversations c
         where c.id = p_conv_id
           and (
                (c.subject_type = 'customer' and exists (
                    select 1 from public.customers cu
                     where cu.id = c.subject_customer_id
                       and cu.user_id = auth.uid()))
             or (c.subject_type = 'business' and exists (
                    select 1 from public.businesses b
                     where b.id = c.subject_business_id
                       and b.owner_user_id = auth.uid()))
             or (c.subject_type = 'partner' and exists (
                    select 1 from public.partners p
                     where p.id = c.subject_partner_id
                       and p.user_id = auth.uid()))
           )
    );
$fn_is_subject$;

grant execute on function public.fn_is_subject_of_conversation(uuid) to authenticated;


-- -----------------------------------------------------------------------------
-- 2. Helper: fn_is_participant_of_conversation
-- -----------------------------------------------------------------------------
create or replace function public.fn_is_participant_of_conversation(p_conv_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $fn_is_part$
    select exists (
        select 1
          from public.conversation_participants cp
         where cp.conversation_id = p_conv_id
           and cp.user_id = auth.uid()
    );
$fn_is_part$;

grant execute on function public.fn_is_participant_of_conversation(uuid) to authenticated;


-- -----------------------------------------------------------------------------
-- 3. Helper: fn_can_read_conversation (admin OR subject OR participant)
-- -----------------------------------------------------------------------------
create or replace function public.fn_can_read_conversation(p_conv_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $fn_can_read$
    select
        public.am_i_admin()
        or public.fn_is_subject_of_conversation(p_conv_id)
        or public.fn_is_participant_of_conversation(p_conv_id);
$fn_can_read$;

grant execute on function public.fn_can_read_conversation(uuid) to authenticated;


-- -----------------------------------------------------------------------------
-- 4. Rebuild conversations policies (no cross-table EXISTS)
-- -----------------------------------------------------------------------------
drop policy if exists conv_subject_read on public.conversations;
create policy conv_subject_read on public.conversations
    for select to authenticated
    using (public.fn_is_subject_of_conversation(id));

drop policy if exists conv_participant_read on public.conversations;
create policy conv_participant_read on public.conversations
    for select to authenticated
    using (public.fn_is_participant_of_conversation(id));

drop policy if exists conv_subject_update on public.conversations;
create policy conv_subject_update on public.conversations
    for update to authenticated
    using (
        public.fn_is_subject_of_conversation(id)
        or public.fn_is_participant_of_conversation(id)
    )
    with check (
        public.fn_is_subject_of_conversation(id)
        or public.fn_is_participant_of_conversation(id)
    );


-- -----------------------------------------------------------------------------
-- 5. Rebuild conversation_participants subject_read policy
-- -----------------------------------------------------------------------------
drop policy if exists conv_part_subject_read on public.conversation_participants;
create policy conv_part_subject_read on public.conversation_participants
    for select to authenticated
    using (public.fn_is_subject_of_conversation(conversation_id));


-- -----------------------------------------------------------------------------
-- 6. Rebuild conversation_messages participant_read policy
-- -----------------------------------------------------------------------------
drop policy if exists conv_msg_participant_read on public.conversation_messages;
create policy conv_msg_participant_read on public.conversation_messages
    for select to authenticated
    using (
        not is_internal_note
        and public.fn_can_read_conversation(conversation_id)
    );


-- -----------------------------------------------------------------------------
-- 7. Smoke-test comment block (run manually to verify the fix)
-- -----------------------------------------------------------------------------
-- After this migration, this query should succeed (return rows, not 42P17):
--   select id, subject_type, kind from public.conversations limit 5;
--
-- And the Edge Function /functions/v1/conversation-send-message should
-- accept a payload with subject_type='partner', kind='support' from a
-- partner-only user (e.g. davebacaywork@gmail.com) and return
-- { ok: true, conversation_id, message_id }.
-- =============================================================================
