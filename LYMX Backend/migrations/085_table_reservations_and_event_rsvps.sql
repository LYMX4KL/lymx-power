-- =============================================================================
-- Migration 085 — table_reservations + event_rsvps
-- =============================================================================
-- Fixes Cluster C tickets:
--   #026db35c "Reserve a Table Request Does Not Persist" — biz-oakline-kitchen
--             button was a literal alert() stub. Now persists to table_reservations.
--   #bad4453f + #bd328940 "No Page Available to View Submitted RSVP List"
--             — admin-launch-rsvps was overloading the feedback table as a hack.
--             Now proper event_rsvps schema; customer-facing my-rsvps.html reads it.
--
-- Idempotent. Named dollar-quotes per feedback_supabase_named_dollar_quotes.
-- =============================================================================

set local statement_timeout = 0;

-- =====================================================================
-- 1. ENUM types
-- =====================================================================
do $enum_reservation_status$
begin
    create type public.reservation_status as enum
        ('pending','confirmed','seated','no_show','cancelled');
exception when duplicate_object then null;
end$enum_reservation_status$;

do $enum_rsvp_status$
begin
    create type public.rsvp_status as enum
        ('going','interested','declined','cancelled');
exception when duplicate_object then null;
end$enum_rsvp_status$;


-- =====================================================================
-- 2. table_reservations — restaurant / bar / cafe table-booking requests
-- =====================================================================
-- Customer-initiated. Business sees a queue in admin or biz dashboard and
-- confirms / declines. Optional integration with their POS later.
create table if not exists public.table_reservations (
    id              uuid primary key default gen_random_uuid(),
    business_id     uuid not null references public.businesses(id) on delete cascade,
    business_slug   text,                        -- denormalized for customer-facing display
    business_name   text,                        -- denormalized

    -- Requester (logged-in user OR anonymous)
    user_id         uuid references auth.users(id) on delete set null,
    booker_name     text not null,
    booker_email    text,
    booker_phone    text,

    -- Reservation details
    party_size      int not null check (party_size between 1 and 50),
    requested_for   timestamptz not null,         -- the date+time of the reservation
    special_notes   text,

    -- Business response
    status          public.reservation_status not null default 'pending',
    confirmed_at    timestamptz,
    confirmed_by    uuid references auth.users(id) on delete set null,
    confirm_notes   text,                         -- "Table 7, ask for Maria"
    cancellation_reason text,

    -- Audit
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    constraint tr_future_time check (requested_for > now() - interval '1 day')
);
create index if not exists idx_tr_business_status
    on public.table_reservations(business_id, status, requested_for);
create index if not exists idx_tr_user
    on public.table_reservations(user_id, requested_for desc)
    where user_id is not null;
create index if not exists idx_tr_pending
    on public.table_reservations(business_id) where status = 'pending';

alter table public.table_reservations enable row level security;

drop policy if exists tr_read_own on public.table_reservations;
create policy tr_read_own on public.table_reservations
    for select to authenticated
    using (
        user_id = auth.uid()
        or public.am_i_admin()
        or exists (select 1 from public.businesses b
                    where b.id = table_reservations.business_id
                      and b.owner_user_id = auth.uid())
    );

drop policy if exists tr_anon_or_user_insert on public.table_reservations;
create policy tr_anon_or_user_insert on public.table_reservations
    for insert
    to anon, authenticated
    with check (true);                       -- public can submit (no auth required)

drop policy if exists tr_biz_owner_update on public.table_reservations;
create policy tr_biz_owner_update on public.table_reservations
    for update to authenticated
    using (
        public.am_i_admin()
        or exists (select 1 from public.businesses b
                    where b.id = table_reservations.business_id
                      and b.owner_user_id = auth.uid())
    )
    with check (
        public.am_i_admin()
        or exists (select 1 from public.businesses b
                    where b.id = table_reservations.business_id
                      and b.owner_user_id = auth.uid())
    );

drop policy if exists tr_user_cancel_self on public.table_reservations;
create policy tr_user_cancel_self on public.table_reservations
    for update to authenticated
    using (user_id = auth.uid() and status in ('pending','confirmed'))
    with check (user_id = auth.uid() and status = 'cancelled');


-- =====================================================================
-- 3. event_rsvps — RSVPs to LYMX-hosted events (launch party, founder dinner, etc.)
-- =====================================================================
-- Currently admin-launch-rsvps.html was reading from feedback table with
-- subject ILIKE 'Launch RSVP:%' — a hack. This is the proper schema.
-- Customer-facing my-rsvps.html reads from here.
create table if not exists public.event_rsvps (
    id              uuid primary key default gen_random_uuid(),
    event_slug      text not null,                -- 'launch-event' / 'founder-dinner' / 'anniversary-event' / etc.
    event_title     text,                         -- snapshot of event title at submit time

    -- Attendee
    user_id         uuid references auth.users(id) on delete set null,
    attendee_name   text not null,
    attendee_email  text,
    attendee_phone  text,
    party_size      int not null default 1 check (party_size between 1 and 20),

    -- RSVP state
    status          public.rsvp_status not null default 'going',
    notes           text,                          -- "Coming with my partner" / "Will arrive late"
    dietary_notes   text,
    plus_ones       text[],                        -- ["Jane Doe","Bob Smith"]

    -- Audit
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    unique (event_slug, attendee_email)            -- one RSVP per email per event
);
create index if not exists idx_er_event_status
    on public.event_rsvps(event_slug, status);
create index if not exists idx_er_user
    on public.event_rsvps(user_id, created_at desc)
    where user_id is not null;

alter table public.event_rsvps enable row level security;

drop policy if exists er_read_own_or_admin on public.event_rsvps;
create policy er_read_own_or_admin on public.event_rsvps
    for select to authenticated
    using (
        user_id = auth.uid()
        or attendee_email = (select email from auth.users where id = auth.uid())
        or public.am_i_admin()
    );

drop policy if exists er_anon_or_user_insert on public.event_rsvps;
create policy er_anon_or_user_insert on public.event_rsvps
    for insert
    to anon, authenticated
    with check (true);                       -- public can RSVP

drop policy if exists er_self_update on public.event_rsvps;
create policy er_self_update on public.event_rsvps
    for update to authenticated
    using (
        user_id = auth.uid()
        or attendee_email = (select email from auth.users where id = auth.uid())
        or public.am_i_admin()
    )
    with check (
        user_id = auth.uid()
        or attendee_email = (select email from auth.users where id = auth.uid())
        or public.am_i_admin()
    );


-- =====================================================================
-- 4. updated_at triggers (reuse helper from migration 084)
-- =====================================================================
do $trg_tr$
begin
    create trigger trg_tr_updated_at before update on public.table_reservations
        for each row execute function public.tg_set_updated_at();
exception when duplicate_object then null;
end$trg_tr$;

do $trg_er$
begin
    create trigger trg_er_updated_at before update on public.event_rsvps
        for each row execute function public.tg_set_updated_at();
exception when duplicate_object then null;
end$trg_er$;


-- =====================================================================
-- 5. Backfill — copy existing 'Launch RSVP:%' rows from feedback into event_rsvps
-- =====================================================================
-- One-time migration of the compact-encoded RSVPs in the feedback table (legacy storage format).
do $backfill_rsvps$
declare v_count int := 0;
begin
    insert into public.event_rsvps (event_slug, event_title, user_id, attendee_name, attendee_email, attendee_phone, status, notes, created_at)
    select
        coalesce(
            substring(f.subject from 'Launch RSVP: ?([^[:space:]\-]+)'),
            'launch-event'
        )                                              as event_slug,
        f.subject                                      as event_title,
        f.user_id,
        coalesce(f.user_email, 'Anonymous')            as attendee_name,
        f.user_email                                   as attendee_email,
        null                                           as attendee_phone,
        'going'::public.rsvp_status                    as status,
        f.message                                      as notes,
        f.created_at
      from public.feedback f
     where f.subject ilike 'Launch RSVP:%'
       and not exists (
            select 1 from public.event_rsvps er
             where er.event_slug = coalesce(substring(f.subject from 'Launch RSVP: ?([^[:space:]\-]+)'),'launch-event')
               and er.attendee_email = f.user_email
       )
    on conflict (event_slug, attendee_email) do nothing;
    get diagnostics v_count = row_count;
    raise notice 'Backfilled % RSVPs from feedback table into event_rsvps', v_count;
exception when others then
    raise notice 'RSVP backfill skipped: %', sqlerrm;
end$backfill_rsvps$;


-- =====================================================================
-- 6. Sanity
-- =====================================================================
do $sanity$
declare v_count int;
begin
    select count(*) into v_count
      from information_schema.tables
     where table_schema='public' and table_name in ('table_reservations','event_rsvps');
    raise notice 'Migration 085 OK — % of 2 expected tables present', v_count;
end$sanity$;

-- =============================================================================
-- END migration 085
-- =============================================================================
