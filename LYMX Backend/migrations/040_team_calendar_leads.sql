-- =============================================================================
-- Migration 040 — Team Calendars + Bookings + Leads (Phase 1 of CRM build)
-- =============================================================================
-- Every team member with a @getlymx.com or @lymxpower.com email gets a public
-- booking page at /c/<handle>. External prospects book a slot, the system
-- creates a Daily.co video room (Jitsi fallback), creates a `leads` row, and
-- attaches a conversation thread for the follow-up timeline.
--
-- New tables:
--   * team_calendars        — one row per bookable team member
--   * availability_rules    — weekly recurring availability
--   * availability_overrides — specific date blocks (vacation, one-off)
--   * bookings              — every booking made
--   * leads                 — the CRM pipeline (booker becomes a lead)
--
-- Existing onboarding_calendar (migration 034) stays for Rachel's special flow;
-- this is the generalized version for the whole team.
-- =============================================================================

-- ===== 1. ENUMS ============================================================
do $$ begin
    create type lead_stage as enum ('new','contacted','qualified','demoed','proposal','won','lost','nurture');
exception when duplicate_object then null; end $$;

do $$ begin
    create type lead_source as enum ('booking','referral','website','admin','import','other');
exception when duplicate_object then null; end $$;

do $$ begin
    create type booking_status as enum ('pending','confirmed','completed','cancelled','no_show');
exception when duplicate_object then null; end $$;


-- ===== 2. team_calendars ====================================================
create table if not exists public.team_calendars (
    id                  uuid primary key default uuid_generate_v4(),
    user_id             uuid not null unique references auth.users(id) on delete cascade,
    handle              text not null unique,             -- URL slug: /c/<handle>  (e.g., 'kenny', 'dave', 'rachel')
    display_name        text not null,
    role_title          text,                              -- 'Founder', 'Customer Success', etc.
    bio                 text,
    timezone            text not null default 'America/Los_Angeles',
    avatar_url          text,
    welcome_message     text default 'Pick a time that works — I look forward to chatting.',

    -- Defaults applied to every booking on this calendar
    default_duration_min int not null default 30,
    buffer_before_min   int not null default 0,
    buffer_after_min    int not null default 10,
    min_notice_hours    int not null default 2,            -- can't book inside this window
    max_advance_days    int not null default 60,           -- can't book past this many days out

    -- Branding
    brand_color         text default '#0a84ff',

    -- State
    is_active           boolean not null default true,
    accepts_bookings    boolean not null default true,

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists idx_team_calendars_handle on public.team_calendars(handle) where is_active = true;
create index if not exists idx_team_calendars_user   on public.team_calendars(user_id);


-- ===== 3. availability_rules — weekly recurring slots =======================
create table if not exists public.availability_rules (
    id                  uuid primary key default uuid_generate_v4(),
    team_calendar_id    uuid not null references public.team_calendars(id) on delete cascade,
    day_of_week         int not null check (day_of_week between 0 and 6),  -- 0=Sun, 6=Sat
    start_time          time not null,                                       -- e.g. '09:00'
    end_time            time not null,                                       -- e.g. '17:00'
    is_active           boolean not null default true,
    created_at          timestamptz not null default now()
);

create index if not exists idx_avail_rules_calendar on public.availability_rules(team_calendar_id);


-- ===== 4. availability_overrides — specific date blocks (vacation / one-off) =====
create table if not exists public.availability_overrides (
    id                  uuid primary key default uuid_generate_v4(),
    team_calendar_id    uuid not null references public.team_calendars(id) on delete cascade,
    override_date       date not null,
    is_blocked          boolean not null default true,    -- true = block this date; false = special open
    start_time          time,                              -- optional, for partial blocks
    end_time            time,
    reason              text,                              -- 'vacation', 'sick', etc.
    created_at          timestamptz not null default now(),
    unique (team_calendar_id, override_date, start_time, end_time)
);

create index if not exists idx_avail_overrides_calendar_date on public.availability_overrides(team_calendar_id, override_date);


-- ===== 5. leads =============================================================
-- One row per prospect/contact. Bookings create leads; leads get a conversation
-- thread for the timeline.
create table if not exists public.leads (
    id                  uuid primary key default uuid_generate_v4(),
    -- Identity
    full_name           text not null,
    email               text not null,
    phone               text,
    company             text,
    role_title          text,
    -- Source
    source              lead_source not null default 'booking',
    source_detail       text,                              -- e.g. landing page URL, partner who referred
    -- Pipeline
    stage               lead_stage not null default 'new',
    owner_user_id       uuid references auth.users(id) on delete set null,
    -- Linkage
    conversation_id     uuid references public.conversations(id) on delete set null,
    customer_id         uuid references public.customers(id) on delete set null,
    business_id         uuid references public.businesses(id) on delete set null,
    -- State
    notes               text,
    next_action         text,
    next_action_due     timestamptz,
    last_contacted_at   timestamptz,
    won_at              timestamptz,
    lost_at             timestamptz,
    lost_reason         text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    unique (email)   -- one lead per email — subsequent bookings update the existing lead
);

create index if not exists idx_leads_stage   on public.leads(stage);
create index if not exists idx_leads_owner   on public.leads(owner_user_id);
create index if not exists idx_leads_email   on public.leads(lower(email));
create index if not exists idx_leads_conv    on public.leads(conversation_id) where conversation_id is not null;


-- ===== 6. bookings ==========================================================
create table if not exists public.bookings (
    id                  uuid primary key default uuid_generate_v4(),
    team_calendar_id    uuid not null references public.team_calendars(id) on delete restrict,
    lead_id             uuid references public.leads(id) on delete set null,

    -- Booker identity (may or may not be a logged-in user)
    booker_user_id      uuid references auth.users(id) on delete set null,
    booker_name         text not null,
    booker_email        text not null,
    booker_phone        text,
    booker_message      text,                              -- "what would you like to talk about?"

    -- Time
    starts_at           timestamptz not null,
    ends_at             timestamptz not null,
    duration_min        int not null,

    -- Video call room
    video_provider      text,                              -- 'daily' | 'jitsi' | 'meet' | 'phone'
    video_room_url      text,
    video_room_id       text,                              -- provider's room id (for transcript fetch)
    video_room_data     jsonb default '{}'::jsonb,         -- raw provider response

    -- Status
    status              booking_status not null default 'confirmed',
    cancellation_reason text,
    cancelled_at        timestamptz,
    completed_at        timestamptz,

    -- Post-call artifacts (filled by call-summary EF later)
    summary             text,
    transcript          text,
    action_items        jsonb default '[]'::jsonb,
    recording_url       text,

    -- Reminders
    reminder_email_sent_at timestamptz,

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists idx_bookings_calendar     on public.bookings(team_calendar_id, starts_at);
create index if not exists idx_bookings_starts_at    on public.bookings(starts_at);
create index if not exists idx_bookings_lead         on public.bookings(lead_id);
create index if not exists idx_bookings_status       on public.bookings(status, starts_at);
create index if not exists idx_bookings_booker_email on public.bookings(lower(booker_email));

-- Prevent two confirmed bookings on the same calendar at the same time
create unique index if not exists uniq_bookings_calendar_time
    on public.bookings(team_calendar_id, starts_at)
    where status in ('confirmed','pending');


-- ===== 7. updated_at trigger ================================================
create or replace function public.set_calendar_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists trg_team_calendars_updated_at on public.team_calendars;
create trigger trg_team_calendars_updated_at
    before update on public.team_calendars
    for each row execute function public.set_calendar_updated_at();

drop trigger if exists trg_leads_updated_at on public.leads;
create trigger trg_leads_updated_at
    before update on public.leads
    for each row execute function public.set_calendar_updated_at();

drop trigger if exists trg_bookings_updated_at on public.bookings;
create trigger trg_bookings_updated_at
    before update on public.bookings
    for each row execute function public.set_calendar_updated_at();


-- ===== 8. RLS =============================================================
alter table public.team_calendars        enable row level security;
alter table public.availability_rules    enable row level security;
alter table public.availability_overrides enable row level security;
alter table public.leads                 enable row level security;
alter table public.bookings              enable row level security;

-- team_calendars: anyone can SELECT active calendars (the public booking page reads them)
drop policy if exists tc_public_read on public.team_calendars;
create policy tc_public_read on public.team_calendars
    for select using (is_active = true);

-- Owner can UPDATE their own calendar
drop policy if exists tc_owner_update on public.team_calendars;
create policy tc_owner_update on public.team_calendars
    for update to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid());

-- Admin can do anything on team_calendars
drop policy if exists tc_admin_all on public.team_calendars;
create policy tc_admin_all on public.team_calendars
    for all to authenticated
    using (public.am_i_admin()) with check (public.am_i_admin());

-- availability_rules: public read (so the booker can see slots), owner can manage
drop policy if exists ar_public_read on public.availability_rules;
create policy ar_public_read on public.availability_rules
    for select using (true);
drop policy if exists ar_owner_manage on public.availability_rules;
create policy ar_owner_manage on public.availability_rules
    for all to authenticated
    using (exists (select 1 from public.team_calendars tc where tc.id = availability_rules.team_calendar_id and tc.user_id = auth.uid()))
    with check (exists (select 1 from public.team_calendars tc where tc.id = availability_rules.team_calendar_id and tc.user_id = auth.uid()));

-- availability_overrides: same pattern
drop policy if exists ao_public_read on public.availability_overrides;
create policy ao_public_read on public.availability_overrides
    for select using (true);
drop policy if exists ao_owner_manage on public.availability_overrides;
create policy ao_owner_manage on public.availability_overrides
    for all to authenticated
    using (exists (select 1 from public.team_calendars tc where tc.id = availability_overrides.team_calendar_id and tc.user_id = auth.uid()))
    with check (exists (select 1 from public.team_calendars tc where tc.id = availability_overrides.team_calendar_id and tc.user_id = auth.uid()));

-- leads: admin can see all; owner can see own; lead itself (if has user_id) can see own
drop policy if exists leads_admin_all on public.leads;
create policy leads_admin_all on public.leads
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());
drop policy if exists leads_owner_read on public.leads;
create policy leads_owner_read on public.leads
    for select to authenticated
    using (owner_user_id = auth.uid());

-- bookings: admin all; the calendar owner sees their bookings; the booker (if logged in) sees their own
drop policy if exists bookings_admin_all on public.bookings;
create policy bookings_admin_all on public.bookings
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());
drop policy if exists bookings_calendar_owner_read on public.bookings;
create policy bookings_calendar_owner_read on public.bookings
    for select to authenticated
    using (exists (select 1 from public.team_calendars tc where tc.id = bookings.team_calendar_id and tc.user_id = auth.uid()));
drop policy if exists bookings_booker_read on public.bookings;
create policy bookings_booker_read on public.bookings
    for select to authenticated
    using (booker_user_id = auth.uid());

-- INSERT for bookings happens via the book-call Edge Function (service role only).


-- ===== 9. Seed Kenny's calendar (so the system has at least one active) ====
insert into public.team_calendars (user_id, handle, display_name, role_title, bio, timezone, welcome_message)
select u.id, 'kenny', 'Kenny Lin', 'Founder',
        'Founder of LYMX Power. Happy to chat about how LYMX works for your business.',
        'America/Los_Angeles',
        'Pick a 30-min slot and I''ll see you there. Camera optional.')
on conflict (user_id) do nothing;

-- Default Kenny availability: Mon-Fri 10am-5pm Pacific
insert into public.availability_rules (team_calendar_id, day_of_week, start_time, end_time)
select (select id from public.team_calendars where handle='kenny'),
       gs::int, '10:00'::time, '17:00'::time
  from generate_series(1, 5) gs
on conflict do nothing;


-- ===== 10. Grants ===========================================================
grant select on public.team_calendars        to anon, authenticated;
grant select on public.availability_rules    to anon, authenticated;
grant select on public.availability_overrides to anon, authenticated;
grant select on public.leads                 to authenticated;
grant select on public.bookings              to authenticated;
grant update on public.team_calendars        to authenticated;
grant insert, update, delete on public.availability_rules    to authenticated;
grant insert, update, delete on public.availability_overrides to authenticated;


-- ===== 11. Verify ===========================================================
select 'migration 040 applied' as status,
       (select count(*) from information_schema.tables
         where table_schema='public'
           and table_name in ('team_calendars','availability_rules','availability_overrides','leads','bookings')) as new_tables_present,
       (select count(*) from public.team_calendars) as seeded_calendars,
       (select count(*) from public.availability_rules) as seeded_rules;
