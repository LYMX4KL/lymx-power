-- =============================================================================
-- Migration 009 — Chat groups, broadcasts, feedback assignment
-- =============================================================================
-- Adds:
--   1. assigned_to column on feedback (so admin can assign to staff/tech later)
--   2. chat_groups + chat_group_members + chat_messages (4 default groups +
--      anyone can create new groups)
--   3. broadcasts table (admin-fired email/in-app announcements)
--
-- Compatible with migration 008. Does NOT alter feedback's existing type or
-- user_role columns — those are kept as-is. The admin UI (tech-support.html)
-- maps the existing values onto Kenny's preferred labels:
--   type:        bug → Bug · question → Help · suggestion → Idea · general → Other
--   user_role:   customer · business · partner · anonymous (already exists)
--
-- Run order: 008 must be applied first.
-- =============================================================================

-- =====================================================================
-- 1. Feedback assignment
-- =====================================================================
alter table public.feedback
    add column if not exists assigned_to       uuid references auth.users(id) on delete set null,
    add column if not exists assigned_at       timestamptz,
    add column if not exists assigned_by       uuid references auth.users(id);

create index if not exists idx_feedback_assigned_to on public.feedback(assigned_to);

-- Assigned partner/staff can read tickets assigned to them
drop policy if exists feedback_select_assigned on public.feedback;
create policy feedback_select_assigned on public.feedback
    for select to authenticated
    using (assigned_to = auth.uid());


-- =====================================================================
-- 2. Chat groups
-- =====================================================================
create table if not exists public.chat_groups (
    id            uuid primary key default uuid_generate_v4(),
    slug          text unique,                -- 'all-staff' | 'admins' | 'all-partners' | 'all-businesses' | uuid for user-created
    name          text not null,
    description   text,
    kind          text not null default 'group' check (kind in ('default','group','dm')),
    -- audience scoping (used by default groups to auto-include members)
    audience      text check (audience in ('all_partners','all_businesses','all_staff','admins','custom') or audience is null),
    is_private    boolean not null default false,

    created_by    uuid references auth.users(id) on delete set null,
    created_at    timestamptz not null default now(),
    last_msg_at   timestamptz
);

create index if not exists idx_chat_groups_audience  on public.chat_groups(audience);
create index if not exists idx_chat_groups_last_msg  on public.chat_groups(last_msg_at desc);

-- Seed the 4 default groups
insert into public.chat_groups (slug, name, description, kind, audience, is_private)
values
    ('all-partners',   'All Partners',   'Every active LYMX Partner. General announcements + downline coordination.', 'default', 'all_partners',   false),
    ('all-businesses', 'All Businesses', 'Every onboarded LYMX Business. Owner-to-owner Q&A.',                        'default', 'all_businesses', false),
    ('all-staff',      'All Staff',      'Internal LYMX team only.',                                                  'default', 'all_staff',      true),
    ('admins',         'Admins',         'Admin-only private channel.',                                               'default', 'admins',         true)
on conflict (slug) do nothing;


-- =====================================================================
-- 3. Chat group members
-- =====================================================================
create table if not exists public.chat_group_members (
    id            uuid primary key default uuid_generate_v4(),
    group_id      uuid not null references public.chat_groups(id) on delete cascade,
    user_id       uuid not null references auth.users(id) on delete cascade,
    role          text not null default 'member' check (role in ('owner','member')),
    joined_at     timestamptz not null default now(),
    last_read_at  timestamptz,
    unique (group_id, user_id)
);

create index if not exists idx_chat_members_user  on public.chat_group_members(user_id);
create index if not exists idx_chat_members_group on public.chat_group_members(group_id);


-- =====================================================================
-- 4. Chat messages
-- =====================================================================
create table if not exists public.chat_messages (
    id            uuid primary key default uuid_generate_v4(),
    group_id      uuid not null references public.chat_groups(id) on delete cascade,
    sender_id     uuid not null references auth.users(id) on delete cascade,
    body          text not null check (char_length(body) >= 1),
    reply_to      uuid references public.chat_messages(id) on delete set null,
    edited_at     timestamptz,
    deleted_at    timestamptz,
    created_at    timestamptz not null default now()
);

create index if not exists idx_chat_msgs_group_time on public.chat_messages(group_id, created_at desc);

-- Bump last_msg_at on the parent group whenever a new message is inserted
create or replace function public.bump_chat_group_last_msg()
returns trigger language plpgsql as $$
begin
  update public.chat_groups
     set last_msg_at = new.created_at
   where id = new.group_id;
  return new;
end;
$$;

drop trigger if exists chat_msg_bump_group on public.chat_messages;
create trigger chat_msg_bump_group
    after insert on public.chat_messages
    for each row execute function public.bump_chat_group_last_msg();


-- =====================================================================
-- 5. Broadcasts (admin-fired announcements)
-- =====================================================================
create table if not exists public.broadcasts (
    id            uuid primary key default uuid_generate_v4(),
    audience      text not null check (audience in ('all_partners','all_businesses','all_customers','all_users','custom')),
    custom_emails text[],                      -- only used when audience = 'custom'
    channel       text not null default 'email' check (channel in ('email','in_app','both')),
    subject       text not null,
    body_html     text not null,               -- rendered HTML
    body_text     text,                        -- optional plain-text fallback
    sent_count    int not null default 0,
    status        text not null default 'draft' check (status in ('draft','sending','sent','failed')),
    error         text,
    sent_at       timestamptz,
    created_by    uuid not null references auth.users(id),
    created_at    timestamptz not null default now()
);

create index if not exists idx_broadcasts_status on public.broadcasts(status, created_at desc);


-- =====================================================================
-- 6. RLS policies
-- =====================================================================
alter table public.chat_groups        enable row level security;
alter table public.chat_group_members enable row level security;
alter table public.chat_messages      enable row level security;
alter table public.broadcasts         enable row level security;

-- ---- chat_groups -----------------------------------------------------
-- Members can see groups they belong to. Default public groups visible to everyone authenticated.
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

-- Authenticated users can create user-defined groups (kind = 'group')
drop policy if exists chat_groups_insert_user on public.chat_groups;
create policy chat_groups_insert_user on public.chat_groups
    for insert to authenticated
    with check (
        kind in ('group','dm')
        and created_by = auth.uid()
    );

-- Owner or admin can update the group
drop policy if exists chat_groups_update_owner on public.chat_groups;
create policy chat_groups_update_owner on public.chat_groups
    for update to authenticated
    using (
        created_by = auth.uid()
        or public.am_i_admin()
    );

-- ---- chat_group_members ---------------------------------------------
-- Members can see other members of their groups
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

-- Group owner / admin can add members
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

-- Self-update for last_read_at
drop policy if exists chat_members_update_self on public.chat_group_members;
create policy chat_members_update_self on public.chat_group_members
    for update to authenticated
    using (user_id = auth.uid());

-- ---- chat_messages --------------------------------------------------
-- Members of the group can see messages
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

-- Members can post
drop policy if exists chat_msgs_insert_member on public.chat_messages;
create policy chat_msgs_insert_member on public.chat_messages
    for insert to authenticated
    with check (
        sender_id = auth.uid()
        and exists (
            select 1 from public.chat_group_members m
             where m.group_id = chat_messages.group_id
               and m.user_id  = auth.uid()
        )
    );

-- Sender can edit/soft-delete own message
drop policy if exists chat_msgs_update_self on public.chat_messages;
create policy chat_msgs_update_self on public.chat_messages
    for update to authenticated
    using (sender_id = auth.uid())
    with check (sender_id = auth.uid());

-- ---- broadcasts -----------------------------------------------------
-- Admin-only for now
drop policy if exists broadcasts_admin_all on public.broadcasts;
create policy broadcasts_admin_all on public.broadcasts
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());


-- =====================================================================
-- 7. Helper view: my chats (with unread + last-msg preview)
-- =====================================================================
create or replace view public.v_my_chats as
select
    g.id            as group_id,
    g.slug,
    g.name,
    g.description,
    g.kind,
    g.audience,
    g.is_private,
    g.last_msg_at,
    m.last_read_at,
    coalesce(
      (select count(*) from public.chat_messages cm
        where cm.group_id = g.id
          and (m.last_read_at is null or cm.created_at > m.last_read_at)
          and cm.sender_id <> auth.uid()
      ), 0
    )::int as unread_count,
    (
      select cm.body from public.chat_messages cm
       where cm.group_id = g.id
         and cm.deleted_at is null
       order by cm.created_at desc limit 1
    ) as last_message_preview
from public.chat_groups g
join public.chat_group_members m on m.group_id = g.id and m.user_id = auth.uid();

grant select on public.v_my_chats to authenticated;


-- =====================================================================
-- 8. Grants
-- =====================================================================
grant select, insert, update on public.chat_groups        to authenticated;
grant select, insert, update on public.chat_group_members to authenticated;
grant select, insert, update on public.chat_messages      to authenticated;
grant select, insert, update on public.broadcasts         to authenticated;

-- =============================================================================
-- End of migration 009
-- =============================================================================
