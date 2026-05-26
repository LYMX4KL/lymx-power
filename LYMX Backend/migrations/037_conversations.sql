-- =============================================================================
-- Migration 037 — Unified communications (Conversations)
-- =============================================================================
-- Mirrors InvestPro PM's owner/tenant communications system.
--
-- BEFORE THIS MIGRATION:
--   * email_sends + email_events  (mig 022) — outbound email log + Resend events
--   * sms_messages                (mig 022) — Twilio SMS log (inbound + outbound)
--   * chat_messages + chat_groups (mig 009/021) — team chat groups
--   * feedback                    (mig 008/016/027) — bug + feedback submissions
--
-- THESE TABLES ARE SILOED. Nothing ties them together so admin can't see
-- "everything customer X said in any channel in one place".
--
-- THIS MIGRATION ADDS:
--   * conversations           — a thread anchored on a subject (customer/business/
--                               partner). Holds assignment + status + priority.
--   * conversation_messages   — every message (in-app / email out / email in /
--                               sms out / sms in / system event / feedback).
--   * conversation_participants — peer-to-peer thread members (customer, business
--                               owner, admins, cc'd staff).
--   * conversation_attachments — files on a message.
--
-- ASSIGNMENT MODEL (Kenny's call):
--   * Sticky-to-last-handler: when an admin sends a message, they become
--     last_handled_by AND assigned_to (if currently NULL or stale).
--   * Claim-if-stale: any admin can call fn_claim_conversation() to take over a
--     thread that has not been handled in CLAIM_STALENESS_HOURS (default 4).
--
-- CHANNEL ROUTING (Kenny's call: full bidirectional):
--   * email_out — outbound via Resend (send-email EF or compose)
--   * email_in  — inbound via Resend Inbound or Cloudflare Email Routing webhook
--                 (conversation-inbound-email EF — to be deployed)
--   * sms_out   — outbound via Twilio (sms-send EF)
--   * sms_in    — inbound via Twilio (sms-inbound EF — updated to write here)
--   * in_app    — typed inside getlymx.com
--   * system    — automated events (conversation created, assigned, resolved)
--
-- BACKWARD COMPAT:
--   * email_sends.conversation_id added (nullable, FK ON DELETE SET NULL)
--   * sms_messages.conversation_id added (nullable)
--   * feedback.conversation_id added (nullable)
--   * Existing data continues to work; backfill is a separate optional step.
-- =============================================================================

-- =====================================================================
-- 1. ENUMS
-- =====================================================================
do $$ begin
    create type conversation_subject_type as enum ('customer','business','partner','none');
exception when duplicate_object then null; end $$;

do $$ begin
    create type conversation_status as enum ('open','pending','resolved','closed','spam');
exception when duplicate_object then null; end $$;

do $$ begin
    create type conversation_kind as enum ('support','feedback','bug','sales','onboarding','compliance','general');
exception when duplicate_object then null; end $$;

do $$ begin
    create type conversation_priority as enum ('low','normal','high','urgent');
exception when duplicate_object then null; end $$;

do $$ begin
    create type message_channel as enum ('in_app','email_out','email_in','sms_out','sms_in','system');
exception when duplicate_object then null; end $$;

do $$ begin
    create type message_sender_type as enum ('admin','customer','business','partner','system','inbound_unknown');
exception when duplicate_object then null; end $$;

do $$ begin
    create type participant_role as enum ('subject','admin','cc','observer');
exception when duplicate_object then null; end $$;


-- =====================================================================
-- 2. conversations — the thread record
-- =====================================================================
create table if not exists public.conversations (
    id                       uuid primary key default uuid_generate_v4(),

    -- WHO this conversation is ABOUT (the anchor record)
    subject_type             conversation_subject_type not null default 'none',
    subject_customer_id      uuid references public.customers(id) on delete set null,
    subject_business_id      uuid references public.businesses(id) on delete set null,
    subject_partner_id       uuid references public.partners(id) on delete set null,

    -- HUMAN-LEGIBLE METADATA
    title                    text,
    kind                     conversation_kind not null default 'support',
    status                   conversation_status not null default 'open',
    priority                 conversation_priority not null default 'normal',

    -- ASSIGNMENT (sticky-to-last-handler)
    assigned_to_user_id      uuid references auth.users(id) on delete set null,
    last_handled_by_user_id  uuid references auth.users(id) on delete set null,
    last_handled_at          timestamptz,

    -- CONVENIENCE DENORM
    last_message_at          timestamptz,
    last_message_preview     text,
    last_message_channel     message_channel,
    message_count            int not null default 0,
    unread_count_admin       int not null default 0,
    unread_count_subject     int not null default 0,

    -- ORIGIN
    created_by_user_id       uuid references auth.users(id) on delete set null,
    source                   text,                       -- 'feedback','manual','inbound_email','inbound_sms','signup','api'
    external_thread_key      text,                       -- e.g. email Message-ID root for grouping replies

    -- LIFECYCLE
    resolved_at              timestamptz,
    resolved_by_user_id      uuid references auth.users(id) on delete set null,
    closed_at                timestamptz,

    created_at               timestamptz not null default now(),
    updated_at               timestamptz not null default now(),

    -- INTEGRITY: subject_type must match the populated id column
    constraint chk_conv_subject_consistency check (
        (subject_type = 'customer' and subject_customer_id is not null and subject_business_id is null and subject_partner_id is null) or
        (subject_type = 'business' and subject_business_id is not null and subject_customer_id is null and subject_partner_id is null) or
        (subject_type = 'partner'  and subject_partner_id  is not null and subject_customer_id is null and subject_business_id is null) or
        (subject_type = 'none'     and subject_customer_id is null and subject_business_id is null and subject_partner_id is null)
    )
);

create index if not exists idx_conversations_subject_customer on public.conversations(subject_customer_id) where subject_customer_id is not null;
create index if not exists idx_conversations_subject_business on public.conversations(subject_business_id) where subject_business_id is not null;
create index if not exists idx_conversations_subject_partner  on public.conversations(subject_partner_id)  where subject_partner_id  is not null;
create index if not exists idx_conversations_assigned         on public.conversations(assigned_to_user_id) where assigned_to_user_id is not null;
create index if not exists idx_conversations_status_priority  on public.conversations(status, priority, last_message_at desc);
create index if not exists idx_conversations_last_message     on public.conversations(last_message_at desc);
create index if not exists idx_conversations_kind             on public.conversations(kind, status);
create index if not exists idx_conversations_external_key     on public.conversations(external_thread_key) where external_thread_key is not null;


-- =====================================================================
-- 3. conversation_messages — every message ever
-- =====================================================================
create table if not exists public.conversation_messages (
    id                       uuid primary key default uuid_generate_v4(),
    conversation_id          uuid not null references public.conversations(id) on delete cascade,

    -- WHO sent it (nullable for inbound_unknown email/SMS where we can't resolve)
    sender_user_id           uuid references auth.users(id) on delete set null,
    sender_type              message_sender_type not null,
    sender_name_snapshot     text,                       -- frozen at insert
    sender_address_snapshot  text,                       -- email or phone, frozen

    -- WHERE it came from
    channel                  message_channel not null,

    -- CONTENT
    subject_line             text,                       -- for emails
    body                     text not null,
    body_html                text,                       -- optional rich HTML for emails

    -- EXTERNAL TRACKING
    external_id              text,                       -- Resend message_id, Twilio sid, etc.
    in_reply_to_external_id  text,                       -- the previous email Message-Id we replied to
    direction                text,                       -- 'inbound' | 'outbound' | 'internal' (helper)

    -- TARGET (for outbound email/sms)
    to_addresses             jsonb default '[]'::jsonb,  -- e.g. ["alice@x.com","bob@x.com"]

    -- LINKS BACK TO LEGACY SILOS (so we can reconcile)
    email_send_id            uuid references public.email_sends(id) on delete set null,
    sms_message_id           uuid references public.sms_messages(id) on delete set null,
    feedback_id              uuid references public.feedback(id)    on delete set null,

    -- READ TRACKING (jsonb keyed by user_id -> ISO timestamp)
    read_by                  jsonb not null default '{}'::jsonb,

    -- INTERNAL NOTES (visible to admins only, not to subject)
    is_internal_note         boolean not null default false,

    created_at               timestamptz not null default now()
);

create index if not exists idx_conv_messages_conv      on public.conversation_messages(conversation_id, created_at desc);
create index if not exists idx_conv_messages_sender    on public.conversation_messages(sender_user_id) where sender_user_id is not null;
create index if not exists idx_conv_messages_external  on public.conversation_messages(external_id) where external_id is not null;
create index if not exists idx_conv_messages_email     on public.conversation_messages(email_send_id) where email_send_id is not null;
create index if not exists idx_conv_messages_sms       on public.conversation_messages(sms_message_id) where sms_message_id is not null;
create index if not exists idx_conv_messages_feedback  on public.conversation_messages(feedback_id) where feedback_id is not null;
create index if not exists idx_conv_messages_channel   on public.conversation_messages(channel);


-- =====================================================================
-- 4. conversation_participants — peer-to-peer membership
-- =====================================================================
-- The "subject" of a conversation gets auto-added as a participant.
-- Admins are implicit participants via RLS (admin policy reads everything).
-- This table is for explicit invited users (cc'd staff, additional business
-- owners, second customer in a 3-way thread, etc.)
create table if not exists public.conversation_participants (
    id                       uuid primary key default uuid_generate_v4(),
    conversation_id          uuid not null references public.conversations(id) on delete cascade,
    user_id                  uuid not null references auth.users(id) on delete cascade,
    role                     participant_role not null default 'cc',
    notify_email             boolean not null default true,
    notify_sms               boolean not null default false,
    last_read_at             timestamptz,
    joined_at                timestamptz not null default now(),
    unique (conversation_id, user_id)
);

create index if not exists idx_conv_participants_user on public.conversation_participants(user_id);
create index if not exists idx_conv_participants_conv on public.conversation_participants(conversation_id);


-- =====================================================================
-- 5. conversation_attachments — files on a message
-- =====================================================================
create table if not exists public.conversation_attachments (
    id                       uuid primary key default uuid_generate_v4(),
    message_id               uuid not null references public.conversation_messages(id) on delete cascade,
    storage_path             text not null,             -- e.g. "conversations/<conv_id>/<msg_id>/file.pdf"
    file_name                text,
    mime_type                text,
    size_bytes               bigint,
    uploaded_by              uuid references auth.users(id) on delete set null,
    created_at               timestamptz not null default now()
);

create index if not exists idx_conv_attachments_msg on public.conversation_attachments(message_id);

-- Storage bucket
do $$ begin
  insert into storage.buckets (id, name, public)
  values ('conversation-attachments', 'conversation-attachments', false)
  on conflict (id) do nothing;
exception when others then
  raise notice 'Skipped bucket creation (create via UI if needed): %', sqlerrm;
end $$;


-- =====================================================================
-- 6. Back-link columns on the legacy silos
-- =====================================================================
alter table public.email_sends   add column if not exists conversation_id uuid references public.conversations(id) on delete set null;
alter table public.sms_messages  add column if not exists conversation_id uuid references public.conversations(id) on delete set null;
alter table public.feedback      add column if not exists conversation_id uuid references public.conversations(id) on delete set null;

create index if not exists idx_email_sends_conv  on public.email_sends(conversation_id) where conversation_id is not null;
create index if not exists idx_sms_messages_conv on public.sms_messages(conversation_id) where conversation_id is not null;
create index if not exists idx_feedback_conv     on public.feedback(conversation_id) where conversation_id is not null;


-- =====================================================================
-- 7. am_i_admin() helper (idempotent — used by RLS below)
-- =====================================================================
create or replace function public.am_i_admin()
returns boolean
language sql
stable
security definer
as $$
    select coalesce(
        (select true
           from public.staff_roles sr
          where sr.user_id = auth.uid()
          limit 1),
        public.am_i_admin()
    );
$$;

grant execute on function public.am_i_admin() to authenticated;


-- =====================================================================
-- 8. RLS — conversations
-- =====================================================================
alter table public.conversations enable row level security;

-- Admins: all
drop policy if exists conv_admin_all on public.conversations;
create policy conv_admin_all on public.conversations
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- Subject can read their own conversations
drop policy if exists conv_subject_read on public.conversations;
create policy conv_subject_read on public.conversations
    for select to authenticated
    using (
        (subject_type = 'customer' and exists (
            select 1 from public.customers c
             where c.id = conversations.subject_customer_id and c.user_id = auth.uid()
        ))
        or
        (subject_type = 'business' and exists (
            select 1 from public.businesses b
             where b.id = conversations.subject_business_id and b.owner_user_id = auth.uid()
        ))
        or
        (subject_type = 'partner' and exists (
            select 1 from public.partners p
             where p.id = conversations.subject_partner_id and p.user_id = auth.uid()
        ))
    );

-- Participants can read conversations they're explicitly in
drop policy if exists conv_participant_read on public.conversations;
create policy conv_participant_read on public.conversations
    for select to authenticated
    using (
        exists (
            select 1 from public.conversation_participants cp
             where cp.conversation_id = conversations.id and cp.user_id = auth.uid()
        )
    );

-- Subjects/participants can update read counters on their threads
drop policy if exists conv_subject_update on public.conversations;
create policy conv_subject_update on public.conversations
    for update to authenticated
    using (
        exists (
            select 1 from public.conversation_participants cp
             where cp.conversation_id = conversations.id and cp.user_id = auth.uid()
        )
        or (subject_type = 'customer' and exists (
            select 1 from public.customers c where c.id = subject_customer_id and c.user_id = auth.uid()
        ))
        or (subject_type = 'business' and exists (
            select 1 from public.businesses b where b.id = subject_business_id and b.owner_user_id = auth.uid()
        ))
        or (subject_type = 'partner' and exists (
            select 1 from public.partners p where p.id = subject_partner_id and p.user_id = auth.uid()
        ))
    );

-- Inserts go through the Edge Function with service role; no public INSERT policy.


-- =====================================================================
-- 9. RLS — conversation_messages
-- =====================================================================
alter table public.conversation_messages enable row level security;

drop policy if exists conv_msg_admin_all on public.conversation_messages;
create policy conv_msg_admin_all on public.conversation_messages
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- Read if you can read the conversation AND the message is not an internal-only admin note
drop policy if exists conv_msg_participant_read on public.conversation_messages;
create policy conv_msg_participant_read on public.conversation_messages
    for select to authenticated
    using (
        not is_internal_note
        and exists (
            select 1 from public.conversations c
             where c.id = conversation_messages.conversation_id
               and (
                   (c.subject_type = 'customer' and exists (
                        select 1 from public.customers cu where cu.id = c.subject_customer_id and cu.user_id = auth.uid()))
                or (c.subject_type = 'business' and exists (
                        select 1 from public.businesses b where b.id = c.subject_business_id and b.owner_user_id = auth.uid()))
                or (c.subject_type = 'partner' and exists (
                        select 1 from public.partners p where p.id = c.subject_partner_id and p.user_id = auth.uid()))
                or exists (
                        select 1 from public.conversation_participants cp
                         where cp.conversation_id = c.id and cp.user_id = auth.uid())
               )
        )
    );


-- =====================================================================
-- 10. RLS — conversation_participants
-- =====================================================================
alter table public.conversation_participants enable row level security;

drop policy if exists conv_part_admin_all on public.conversation_participants;
create policy conv_part_admin_all on public.conversation_participants
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- See your own participant rows
drop policy if exists conv_part_self_read on public.conversation_participants;
create policy conv_part_self_read on public.conversation_participants
    for select to authenticated
    using (user_id = auth.uid());

-- Subjects can see who else is on the thread
drop policy if exists conv_part_subject_read on public.conversation_participants;
create policy conv_part_subject_read on public.conversation_participants
    for select to authenticated
    using (
        exists (
            select 1 from public.conversations c
             where c.id = conversation_participants.conversation_id
               and (
                   (c.subject_type = 'customer' and exists (select 1 from public.customers cu where cu.id = c.subject_customer_id and cu.user_id = auth.uid()))
                or (c.subject_type = 'business' and exists (select 1 from public.businesses b where b.id = c.subject_business_id and b.owner_user_id = auth.uid()))
                or (c.subject_type = 'partner'  and exists (select 1 from public.partners p where p.id = c.subject_partner_id and p.user_id = auth.uid()))
               )
        )
    );


-- =====================================================================
-- 11. RLS — conversation_attachments
-- =====================================================================
alter table public.conversation_attachments enable row level security;

drop policy if exists conv_att_admin_all on public.conversation_attachments;
create policy conv_att_admin_all on public.conversation_attachments
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

drop policy if exists conv_att_participant_read on public.conversation_attachments;
create policy conv_att_participant_read on public.conversation_attachments
    for select to authenticated
    using (
        exists (
            select 1 from public.conversation_messages m
             join public.conversations c on c.id = m.conversation_id
            where m.id = conversation_attachments.message_id
              and (
                   public.am_i_admin()
                or exists (select 1 from public.conversation_participants cp
                            where cp.conversation_id = c.id and cp.user_id = auth.uid())
              )
        )
    );


-- =====================================================================
-- 12. TRIGGERS — sticky-assign + denormalized counters
-- =====================================================================
-- When ANY message lands, bump conversations.last_message_at / preview / count.
-- When an ADMIN message lands, also bump last_handled_by + last_handled_at,
-- and auto-assign if the conversation has no assignee yet.

create or replace function public.conv_msg_after_insert()
returns trigger
language plpgsql
security definer
as $$
declare
    v_is_admin boolean;
    v_preview  text;
begin
    -- Snapshot sender name if missing
    if new.sender_name_snapshot is null and new.sender_user_id is not null then
        select coalesce(
            (select coalesce(p.display_name, p.legal_name)
               from public.partners p where p.user_id = new.sender_user_id limit 1),
            (select coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email,'@',1))
               from auth.users u where u.id = new.sender_user_id),
            'Unknown'
        ) into new.sender_name_snapshot;
    end if;

    -- Truncated preview for the conversations row
    v_preview := substring(coalesce(new.body,'') from 1 for 200);

    -- Is the sender an admin? (uses staff_roles or hardcoded Kenny)
    v_is_admin := exists (
        select 1 from public.staff_roles where user_id = new.sender_user_id
    ) or exists (select 1 from public.staff_roles sr where sr.user_id = new.sender_user_id and sr.role = 'admin');

    if v_is_admin then
        update public.conversations c set
            last_message_at         = now(),
            last_message_preview    = v_preview,
            last_message_channel    = new.channel,
            message_count           = c.message_count + 1,
            last_handled_by_user_id = new.sender_user_id,
            last_handled_at         = now(),
            assigned_to_user_id     = coalesce(c.assigned_to_user_id, new.sender_user_id),
            unread_count_subject    = c.unread_count_subject + (case when new.is_internal_note then 0 else 1 end),
            updated_at              = now()
          where id = new.conversation_id;
    else
        update public.conversations c set
            last_message_at         = now(),
            last_message_preview    = v_preview,
            last_message_channel    = new.channel,
            message_count           = c.message_count + 1,
            unread_count_admin      = c.unread_count_admin + 1,
            updated_at              = now()
          where id = new.conversation_id;
    end if;

    return new;
end;
$$;

drop trigger if exists trg_conv_msg_after_insert on public.conversation_messages;
create trigger trg_conv_msg_after_insert
    after insert on public.conversation_messages
    for each row execute function public.conv_msg_after_insert();


-- updated_at on conversations
create or replace function public.set_conversation_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists trg_conv_updated_at on public.conversations;
create trigger trg_conv_updated_at
    before update on public.conversations
    for each row execute function public.set_conversation_updated_at();


-- =====================================================================
-- 13. RPC — fn_claim_conversation (the claim-if-stale override)
-- =====================================================================
-- An admin can claim a conversation if it has been idle for >= staleness
-- hours OR if it's currently unassigned. This is the override Kenny wants
-- on top of sticky-to-last-handler.
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
as $$
declare
    v_now           timestamptz := now();
    v_caller        uuid := auth.uid();
    v_is_admin      boolean;
    v_prev          uuid;
    v_last_handled  timestamptz;
begin
    if v_caller is null then
        raise exception 'claim requires authentication';
    end if;

    v_is_admin := public.am_i_admin();
    if not v_is_admin then
        raise exception 'only admins can claim conversations';
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
$$;

grant execute on function public.fn_claim_conversation(uuid, int) to authenticated;


-- =====================================================================
-- 14. RPC — fn_find_or_create_conversation
-- =====================================================================
-- Edge Functions + signup flows + feedback widget all use this to attach
-- a new message to an existing open thread (sticky) or open a new one.
create or replace function public.fn_find_or_create_conversation(
    p_subject_type    conversation_subject_type,
    p_subject_id      uuid,
    p_kind            conversation_kind,
    p_title           text default null,
    p_source          text default 'api',
    p_created_by      uuid default null
)
returns uuid
language plpgsql
security definer
as $$
declare
    v_conv_id uuid;
    v_existing_id uuid;
begin
    -- Look for an open conversation with the same subject + kind (sticky)
    if p_subject_type = 'customer' then
        select id into v_existing_id from public.conversations
         where subject_type = 'customer' and subject_customer_id = p_subject_id
           and kind = p_kind and status in ('open','pending')
         order by last_message_at desc nulls last
         limit 1;
    elsif p_subject_type = 'business' then
        select id into v_existing_id from public.conversations
         where subject_type = 'business' and subject_business_id = p_subject_id
           and kind = p_kind and status in ('open','pending')
         order by last_message_at desc nulls last
         limit 1;
    elsif p_subject_type = 'partner' then
        select id into v_existing_id from public.conversations
         where subject_type = 'partner' and subject_partner_id = p_subject_id
           and kind = p_kind and status in ('open','pending')
         order by last_message_at desc nulls last
         limit 1;
    end if;

    if v_existing_id is not null then
        return v_existing_id;
    end if;

    -- Create a new one
    insert into public.conversations (
        subject_type,
        subject_customer_id,
        subject_business_id,
        subject_partner_id,
        kind, title, status, source, created_by_user_id
    ) values (
        p_subject_type,
        case when p_subject_type = 'customer' then p_subject_id end,
        case when p_subject_type = 'business' then p_subject_id end,
        case when p_subject_type = 'partner'  then p_subject_id end,
        p_kind,
        coalesce(p_title, p_kind::text),
        'open',
        p_source,
        p_created_by
    ) returning id into v_conv_id;

    return v_conv_id;
end;
$$;

grant execute on function public.fn_find_or_create_conversation(conversation_subject_type, uuid, conversation_kind, text, text, uuid) to authenticated;


-- =====================================================================
-- 15. TRIGGERS on feedback — auto-create + link a conversation
-- =====================================================================
-- TWO triggers:
--   * BEFORE INSERT: resolve subject, find-or-create conversation, set new.conversation_id
--   * AFTER INSERT:  insert the first conversation_message (FK to feedback.id
--                    needs the parent row to exist first)

create or replace function public.feedback_before_insert_link_conv()
returns trigger
language plpgsql
security definer
as $$
declare
    v_subject_type conversation_subject_type;
    v_subject_id   uuid;
    v_kind         conversation_kind;
    v_conv_id      uuid;
begin
    if new.conversation_id is not null then
        return new;
    end if;

    v_kind := case new.type
        when 'bug' then 'bug'
        when 'question' then 'support'
        when 'suggestion' then 'feedback'
        else 'feedback'
    end::conversation_kind;

    if new.user_id is not null then
        select id, 'customer'::conversation_subject_type into v_subject_id, v_subject_type
          from public.customers where user_id = new.user_id limit 1;
        if v_subject_id is null then
            select id, 'partner'::conversation_subject_type into v_subject_id, v_subject_type
              from public.partners where user_id = new.user_id limit 1;
        end if;
    end if;
    v_subject_type := coalesce(v_subject_type, 'none'::conversation_subject_type);

    v_conv_id := public.fn_find_or_create_conversation(
        v_subject_type, v_subject_id, v_kind,
        coalesce(new.subject, left(new.message, 80)),
        'feedback', new.user_id
    );

    new.conversation_id := v_conv_id;
    return new;
end;
$$;

drop trigger if exists trg_feedback_before_link_conv on public.feedback;
create trigger trg_feedback_before_link_conv
    before insert on public.feedback
    for each row execute function public.feedback_before_insert_link_conv();


create or replace function public.feedback_after_insert_seed_message()
returns trigger
language plpgsql
security definer
as $$
declare
    v_sender_type message_sender_type;
begin
    if new.conversation_id is null then
        return new;
    end if;

    v_sender_type := case lower(coalesce(new.user_role,'customer'))
        when 'business'  then 'business'::message_sender_type
        when 'partner'   then 'partner'::message_sender_type
        when 'admin'     then 'admin'::message_sender_type
        when 'anonymous' then 'inbound_unknown'::message_sender_type
        else 'customer'::message_sender_type
    end;

    insert into public.conversation_messages (
        conversation_id, sender_user_id, sender_type, channel,
        subject_line, body, feedback_id, direction
    ) values (
        new.conversation_id,
        new.user_id,
        v_sender_type,
        'in_app',
        new.subject,
        new.message,
        new.id,
        'inbound'
    );

    return new;
end;
$$;

drop trigger if exists trg_feedback_after_seed_message on public.feedback;
create trigger trg_feedback_after_seed_message
    after insert on public.feedback
    for each row execute function public.feedback_after_insert_seed_message();


-- =====================================================================
-- 16. GRANTS
-- =====================================================================
grant select on public.conversations to authenticated;
grant update on public.conversations to authenticated;
grant select on public.conversation_messages to authenticated;
grant select on public.conversation_participants to authenticated;
grant select on public.conversation_attachments to authenticated;
-- INSERT/DELETE intentionally only via Edge Function (service-role)


-- =====================================================================
-- 17. VERIFY
-- =====================================================================
select 'migration 037 applied' as status,
       (select count(*) from information_schema.tables
         where table_schema='public'
           and table_name in ('conversations','conversation_messages','conversation_participants','conversation_attachments')) as new_tables_present,
       (select count(*) from information_schema.columns
         where table_schema='public'
           and column_name='conversation_id'
           and table_name in ('email_sends','sms_messages','feedback')) as backlinks_present,
       (select count(*) from pg_proc
         where proname in ('fn_claim_conversation','fn_find_or_create_conversation','am_i_admin')) as functions_present;
