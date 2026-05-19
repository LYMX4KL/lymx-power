-- =============================================================================
-- Migration 021 — Chat enhancements (mirror InvestPro 055/057)
-- =============================================================================
-- Adds to chat_messages (already exists from 009):
--   1. author_name_snapshot — frozen at insert via trigger
--   2. mentions JSONB        — list of profile_ids tagged with @
--   3. attachments JSONB     — small list metadata, large files via storage bucket
--
-- New tables:
--   - chat_attachments (file/photo uploads, links to chat_messages)
--
-- New views:
--   - v_chat_members_directory — searchable directory for the @mention picker
--
-- Realtime publication:
--   - chat_messages + chat_groups added to supabase_realtime publication
--
-- Compatible with migrations 009 + 008. Idempotent.
-- =============================================================================

-- =====================================================================
-- 1. Add columns to chat_messages
-- =====================================================================
alter table public.chat_messages
    add column if not exists author_name_snapshot text,
    add column if not exists mentions             jsonb not null default '[]'::jsonb,
    add column if not exists attachments          jsonb not null default '[]'::jsonb;

-- Author-name snapshot trigger (frozen at insert time)
create or replace function public.chat_msg_snapshot_author()
returns trigger
language plpgsql
security definer
as $$
declare
    v_name text;
begin
    if new.author_name_snapshot is null or new.author_name_snapshot = '' then
        -- Try partners.display_name, then partners.legal_name, then auth metadata, then email local-part
        select coalesce(
            (select coalesce(p.display_name, p.legal_name)
               from public.partners p where p.user_id = new.sender_id limit 1),
            (select coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', split_part(u.email,'@',1))
               from auth.users u where u.id = new.sender_id limit 1),
            'Unknown'
        ) into v_name;
        new.author_name_snapshot := v_name;
    end if;

    -- Also bump parent group's last_msg_at
    update public.chat_groups
       set last_msg_at = now()
     where id = new.group_id;

    return new;
end;
$$;

drop trigger if exists trg_chat_msg_snapshot_author on public.chat_messages;
create trigger trg_chat_msg_snapshot_author
    before insert on public.chat_messages
    for each row execute function public.chat_msg_snapshot_author();


-- =====================================================================
-- 2. Chat attachments table
-- =====================================================================
create table if not exists public.chat_attachments (
    id              uuid primary key default uuid_generate_v4(),
    message_id      uuid not null references public.chat_messages(id) on delete cascade,
    storage_path    text not null,            -- e.g. "chat/<group_id>/<message_id>/photo.png"
    file_name       text,
    mime_type       text,
    size_bytes      bigint,
    width_px        int,
    height_px       int,
    uploaded_by     uuid references auth.users(id) on delete set null,
    created_at      timestamptz not null default now()
);

create index if not exists idx_chat_attachments_message on public.chat_attachments(message_id);

alter table public.chat_attachments enable row level security;

-- Anyone in the channel can read the attachment row (file ACL still enforced by storage)
drop policy if exists chat_attachments_member_read on public.chat_attachments;
create policy chat_attachments_member_read on public.chat_attachments
    for select to authenticated
    using (
        exists (
            select 1 from public.chat_messages m
            join public.chat_group_members gm on gm.group_id = m.group_id
            where m.id = chat_attachments.message_id
              and gm.user_id = auth.uid()
        )
    );

drop policy if exists chat_attachments_uploader_insert on public.chat_attachments;
create policy chat_attachments_uploader_insert on public.chat_attachments
    for insert to authenticated
    with check (uploaded_by = auth.uid());


-- =====================================================================
-- 3. Mention notifications (a thin wrapper on top of chat_messages.mentions)
-- =====================================================================
create table if not exists public.chat_mention_notifications (
    id              uuid primary key default uuid_generate_v4(),
    message_id      uuid not null references public.chat_messages(id) on delete cascade,
    group_id        uuid not null references public.chat_groups(id) on delete cascade,
    mentioned_user  uuid not null references auth.users(id) on delete cascade,
    read_at         timestamptz,
    created_at      timestamptz not null default now(),
    unique (message_id, mentioned_user)
);

create index if not exists idx_chat_mention_user_unread
    on public.chat_mention_notifications(mentioned_user)
 where read_at is null;

alter table public.chat_mention_notifications enable row level security;

drop policy if exists mn_self_read on public.chat_mention_notifications;
create policy mn_self_read on public.chat_mention_notifications
    for select to authenticated
    using (mentioned_user = auth.uid());

drop policy if exists mn_self_update on public.chat_mention_notifications;
create policy mn_self_update on public.chat_mention_notifications
    for update to authenticated
    using (mentioned_user = auth.uid())
    with check (mentioned_user = auth.uid());

-- service-role inserts via Edge Function only — no public INSERT policy


-- =====================================================================
-- 4. Directory view used by @mention autocomplete
-- =====================================================================
-- Returns chat-eligible profiles the caller shares at least one group with.
-- Local-part of email + full name both serve as match handles.
create or replace view public.v_chat_members_directory as
select distinct
    u.id                                          as user_id,
    coalesce(p.display_name, p.legal_name,
             u.raw_user_meta_data->>'full_name',
             split_part(u.email,'@',1))           as display_name,
    split_part(u.email,'@',1)                     as handle_short,
    u.email                                       as email,
    case
        when exists (select 1 from public.partners pp where pp.user_id = u.id) then 'partner'
        when exists (select 1 from public.businesses b where b.owner_user_id = u.id) then 'business'
        else 'customer'
    end                                           as role_hint
  from auth.users u
  left join public.partners p on p.user_id = u.id
 where u.id in (
        select gm.user_id from public.chat_group_members gm
         where gm.group_id in (
               select group_id from public.chat_group_members where user_id = auth.uid()
         )
   );

alter view public.v_chat_members_directory set (security_invoker = on);
grant select on public.v_chat_members_directory to authenticated;


-- =====================================================================
-- 5. Realtime — add chat tables to supabase_realtime publication
-- =====================================================================
do $$
begin
    if not exists (
        select 1 from pg_publication_tables
         where pubname='supabase_realtime' and schemaname='public' and tablename='chat_messages'
    ) then
        execute 'alter publication supabase_realtime add table public.chat_messages';
    end if;
    if not exists (
        select 1 from pg_publication_tables
         where pubname='supabase_realtime' and schemaname='public' and tablename='chat_groups'
    ) then
        execute 'alter publication supabase_realtime add table public.chat_groups';
    end if;
    if not exists (
        select 1 from pg_publication_tables
         where pubname='supabase_realtime' and schemaname='public' and tablename='chat_mention_notifications'
    ) then
        execute 'alter publication supabase_realtime add table public.chat_mention_notifications';
    end if;
exception when others then
    raise notice 'realtime publication update skipped: %', sqlerrm;
end$$;


-- =====================================================================
-- 6. Verify
-- =====================================================================
select 'migration 021 applied' as status,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='chat_messages'
           and column_name in ('author_name_snapshot','mentions','attachments')) as new_columns_present,
       (select count(*) from information_schema.tables
         where table_schema='public' and table_name in ('chat_attachments','chat_mention_notifications')) as new_tables_pre