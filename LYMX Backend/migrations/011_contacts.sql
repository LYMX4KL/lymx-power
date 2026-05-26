-- =============================================================================
-- Migration 011 — Per-user contact book (with tags and lists)
-- =============================================================================
-- Lets every user (Partner, Business, Customer, Admin) keep their own private
-- address book. Powers the universal contacts.html page and the invite tool.
--
-- Tables:
--   contacts             — one row per (owner_id, email)
--   contact_tags         — flat tag dictionary scoped per owner
--   contact_tag_links    — many-to-many (contact ↔ tag)
--   contact_lists        — named lists (e.g. "Family", "Coffee shops")
--   contact_list_members — many-to-many (contact ↔ list)
-- =============================================================================

-- =====================================================================
-- 1. contacts
-- =====================================================================
create table if not exists public.contacts (
    id              uuid primary key default uuid_generate_v4(),
    owner_id        uuid not null references auth.users(id) on delete cascade,

    -- Core identity
    email           text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    first_name      text,
    last_name       text,
    full_name       text generated always as (
        trim(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))
    ) stored,

    -- Optional details
    phone           text,
    company         text,
    job_title       text,
    notes           text,

    -- Source of import
    source          text default 'manual' check (source in ('manual','paste','csv','google','outlook','apple','referral','signup')),

    -- Activity tracking
    last_invited_at timestamptz,
    invite_count    int not null default 0,
    signed_up       boolean not null default false,
    signed_up_user_id uuid references auth.users(id) on delete set null,

    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    -- One contact per (owner, email) — auto-merge on re-import
    unique (owner_id, email)
);

create index if not exists idx_contacts_owner       on public.contacts(owner_id, created_at desc);
create index if not exists idx_contacts_email       on public.contacts(email);
create index if not exists idx_contacts_owner_name  on public.contacts(owner_id, full_name);

-- =====================================================================
-- 2. contact_tags
-- =====================================================================
create table if not exists public.contact_tags (
    id          uuid primary key default uuid_generate_v4(),
    owner_id    uuid not null references auth.users(id) on delete cascade,
    name        text not null check (char_length(name) between 1 and 40),
    color       text default '#0a84ff',
    created_at  timestamptz not null default now(),
    unique (owner_id, name)
);

create index if not exists idx_contact_tags_owner on public.contact_tags(owner_id);

-- =====================================================================
-- 3. contact_tag_links (many-to-many)
-- =====================================================================
create table if not exists public.contact_tag_links (
    contact_id  uuid not null references public.contacts(id) on delete cascade,
    tag_id      uuid not null references public.contact_tags(id) on delete cascade,
    primary key (contact_id, tag_id)
);

create index if not exists idx_tag_links_tag on public.contact_tag_links(tag_id);

-- =====================================================================
-- 4. contact_lists
-- =====================================================================
create table if not exists public.contact_lists (
    id           uuid primary key default uuid_generate_v4(),
    owner_id     uuid not null references auth.users(id) on delete cascade,
    name         text not null check (char_length(name) between 1 and 60),
    description  text,
    color        text default '#13a26b',
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    unique (owner_id, name)
);

create index if not exists idx_contact_lists_owner on public.contact_lists(owner_id);

-- =====================================================================
-- 5. contact_list_members
-- =====================================================================
create table if not exists public.contact_list_members (
    list_id      uuid not null references public.contact_lists(id) on delete cascade,
    contact_id   uuid not null references public.contacts(id) on delete cascade,
    added_at     timestamptz not null default now(),
    primary key (list_id, contact_id)
);

create index if not exists idx_list_members_contact on public.contact_list_members(contact_id);

-- =====================================================================
-- 6. updated_at triggers
-- =====================================================================
create or replace function public.set_contacts_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists contacts_updated_at on public.contacts;
create trigger contacts_updated_at
    before update on public.contacts
    for each row execute function public.set_contacts_updated_at();

drop trigger if exists contact_lists_updated_at on public.contact_lists;
create trigger contact_lists_updated_at
    before update on public.contact_lists
    for each row execute function public.set_contacts_updated_at();

-- =====================================================================
-- 7. RLS — owners read/write their own contacts; admin sees everyone's
-- =====================================================================
alter table public.contacts             enable row level security;
alter table public.contact_tags         enable row level security;
alter table public.contact_tag_links    enable row level security;
alter table public.contact_lists        enable row level security;
alter table public.contact_list_members enable row level security;

-- ---- contacts ----
drop policy if exists contacts_owner_all on public.contacts;
create policy contacts_owner_all on public.contacts
    for all to authenticated
    using (owner_id = auth.uid())
    with check (owner_id = auth.uid());

drop policy if exists contacts_admin_all on public.contacts;
create policy contacts_admin_all on public.contacts
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- ---- contact_tags ----
drop policy if exists tags_owner_all on public.contact_tags;
create policy tags_owner_all on public.contact_tags
    for all to authenticated
    using (owner_id = auth.uid())
    with check (owner_id = auth.uid());

drop policy if exists tags_admin_all on public.contact_tags;
create policy tags_admin_all on public.contact_tags
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- ---- contact_tag_links (joined via contacts.owner_id) ----
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

-- ---- contact_lists ----
drop policy if exists lists_owner_all on public.contact_lists;
create policy lists_owner_all on public.contact_lists
    for all to authenticated
    using (owner_id = auth.uid())
    with check (owner_id = auth.uid());

drop policy if exists lists_admin_all on public.contact_lists;
create policy lists_admin_all on public.contact_lists
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- ---- contact_list_members (joined via contact_lists.owner_id) ----
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

-- =====================================================================
-- 8. Helper view — contacts with their tags + lists pre-aggregated
-- =====================================================================
create or replace view public.v_my_contacts as
select
    c.id,
    c.owner_id,
    c.email,
    c.first_name,
    c.last_name,
    c.full_name,
    c.phone,
    c.company,
    c.job_title,
    c.notes,
    c.source,
    c.last_invited_at,
    c.invite_count,
    c.signed_up,
    c.created_at,
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

-- =====================================================================
-- 9. Grants
-- =====================================================================
grant select, insert, update, delete on public.contacts             to authenticated;
grant select, insert, update, delete on public.contact_tags         to authenticated;
grant select, insert, update, delete on public.contact_tag_links    to authenticated;
grant select, insert, update, delete on public.contact_lists        to authenticated;
grant select, insert, update, delete on public.contact_list_members to authenticated;

-- =============================================================================
-- End of migration 011
-- =============================================================================
