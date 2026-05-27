-- =====================================================================
-- Migration 122 — Events + event speakers (admin-create, speaker
-- magic-link, public launch page reads real data)
-- =====================================================================
-- 2026-05-27 — backs the launch-event.html page (previously hardcoded
-- speakers Maya Hopkins / Sienna Vega / Daniel Whitley / Maria Lopez)
-- with real `public.events` + `public.event_speakers` tables. Reusable
-- for any future event (launch, town halls, partner mixers, etc.).
--
-- Flow:
--   1. Admin creates a row in `events` via /admin-events.html
--   2. Admin invites a speaker via /admin-event-edit.html — generates a
--      one-time UUID token, inserts `event_speakers` row with status='invited'
--   3. Admin pastes the magic-link URL into an email to the speaker
--   4. Speaker opens /event-speaker-edit.html?t=<token>, fills name +
--      title + bio + talk + uploads photo to `event-speakers` Storage
--      bucket → status='profile_complete', token cleared
--   5. Admin reviews + publishes the event (status='published')
--   6. /launch-event.html (and /event-<slug>.html) read from these tables
--
-- Pattern mirrors the offers + accept_token model from migration 121.
-- =====================================================================

begin;

-- ---------- 1. events ------------------------------------------------------
create table if not exists public.events (
    id                   uuid primary key default gen_random_uuid(),
    slug                 text not null unique,         -- e.g. 'lymx-launch-25'
    title                text not null,                -- e.g. 'LYMX Public Launch'
    subtitle             text,                          -- short tagline
    description_md       text,                          -- long-form intro

    event_at             timestamptz not null,          -- start date/time
    end_at               timestamptz,                   -- optional end
    timezone             text not null default 'America/Los_Angeles',

    location_name        text,                          -- e.g. 'Container Park'
    location_address     text,                          -- street address
    location_url         text,                          -- google maps / venue url
    capacity             int,                           -- optional cap

    header_image_path    text,                          -- storage path for hero
    status               text not null default 'draft'
                              check (status in ('draft','published','archived')),
    published_at         timestamptz,
    published_url        text,                          -- canonical public URL once published

    created_by_id        uuid references auth.users(id) on delete set null,
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now()
);

create index if not exists idx_events_status     on public.events(status, event_at desc);
create index if not exists idx_events_slug       on public.events(slug);

comment on table public.events is
    'Network-wide events (launches, town halls, partner mixers). Public when '
    'status=published; replaces the previous hardcoded launch-event.html data.';

-- ---------- 2. event_speakers ---------------------------------------------
create table if not exists public.event_speakers (
    id                   uuid primary key default gen_random_uuid(),
    event_id             uuid not null references public.events(id) on delete cascade,

    -- Identity
    display_name         text not null,                 -- 'Sienna Vega'
    title                text,                          -- 'Master Partner'
    company              text,                          -- 'Las Vegas territory'
    bio                  text,                          -- short bio paragraph
    photo_path           text,                          -- storage path (event-speakers bucket)

    -- Talk
    talk_title           text,                          -- 'Why LYMX matters'
    talk_description     text,
    talk_at              timestamptz,                   -- when they're on stage (optional)

    -- Invite + completion
    invite_email         text,                          -- where the magic link was sent
    invite_token         uuid,                          -- nullable; cleared after submit
    invite_token_expires_at timestamptz,
    invite_token_issued_at timestamptz,
    invited_by_id        uuid references auth.users(id) on delete set null,
    invited_at           timestamptz,
    completed_via_token  boolean not null default false,
    completed_at         timestamptz,

    -- Lifecycle
    status               text not null default 'invited'
                              check (status in ('invited','profile_complete','published','declined')),
    sort_order           int  not null default 100,     -- display order on the public page

    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now()
);

create unique index if not exists idx_event_speakers_invite_token
    on public.event_speakers (invite_token)
    where invite_token is not null;
create index if not exists idx_event_speakers_event       on public.event_speakers(event_id, sort_order);
create index if not exists idx_event_speakers_status      on public.event_speakers(status);

comment on table public.event_speakers is
    'One row per speaker per event. invite_token is a one-time-use UUID that '
    'lets the speaker self-edit via /event-speaker-edit.html?t=<uuid> without '
    'signing in. Cleared on submit (same pattern as offers.accept_token).';

-- ---------- 3. updated_at triggers ----------------------------------------
create or replace function public._events_touch_updated_at()
returns trigger language plpgsql as $$
begin NEW.updated_at := now(); return NEW; end;
$$;

drop trigger if exists trg_events_touch on public.events;
create trigger trg_events_touch before update on public.events
    for each row execute function public._events_touch_updated_at();

drop trigger if exists trg_event_speakers_touch on public.event_speakers;
create trigger trg_event_speakers_touch before update on public.event_speakers
    for each row execute function public._events_touch_updated_at();

-- ---------- 4. RLS --------------------------------------------------------
alter table public.events          enable row level security;
alter table public.event_speakers  enable row level security;

-- events
drop policy if exists events_public_read on public.events;
create policy events_public_read on public.events
    for select to anon, authenticated
    using (status = 'published');

drop policy if exists events_admin_all on public.events;
create policy events_admin_all on public.events
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- event_speakers — public can read ONLY speakers whose event is published AND speaker status is published
drop policy if exists event_speakers_public_read on public.event_speakers;
create policy event_speakers_public_read on public.event_speakers
    for select to anon, authenticated
    using (
        status = 'published'
        and exists (
            select 1 from public.events e
             where e.id = event_speakers.event_id
               and e.status = 'published'
        )
    );

drop policy if exists event_speakers_admin_all on public.event_speakers;
create policy event_speakers_admin_all on public.event_speakers
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- ---------- 5. Token-based RPCs for the magic-link speaker page -----------
-- Resolve token → returns event + speaker fields the speaker needs to see
-- on the edit page. Mirror of fn_offer_resolve_by_token from migration 121.
create or replace function public.fn_event_speaker_resolve_by_token(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_speaker record;
    v_event   record;
begin
    if p_token is null then
        return jsonb_build_object('ok', false, 'error', 'no_token');
    end if;

    select * into v_speaker
      from public.event_speakers
     where invite_token = p_token
     limit 1;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'token_not_found');
    end if;

    if v_speaker.invite_token_expires_at is not null
       and v_speaker.invite_token_expires_at < now() then
        return jsonb_build_object('ok', false, 'error', 'token_expired',
            'expired_at', v_speaker.invite_token_expires_at);
    end if;

    if v_speaker.status not in ('invited','profile_complete') then
        return jsonb_build_object('ok', false, 'error', 'speaker_status_locked',
            'status', v_speaker.status);
    end if;

    select * into v_event from public.events where id = v_speaker.event_id;

    return jsonb_build_object(
        'ok', true,
        'speaker_id', v_speaker.id,
        'event_id', v_speaker.event_id,
        'event_slug', v_event.slug,
        'event_title', v_event.title,
        'event_at', v_event.event_at,
        'event_location_name', v_event.location_name,
        'speaker', jsonb_build_object(
            'display_name', coalesce(v_speaker.display_name, ''),
            'title', coalesce(v_speaker.title, ''),
            'company', coalesce(v_speaker.company, ''),
            'bio', coalesce(v_speaker.bio, ''),
            'photo_path', coalesce(v_speaker.photo_path, ''),
            'talk_title', coalesce(v_speaker.talk_title, ''),
            'talk_description', coalesce(v_speaker.talk_description, ''),
            'invite_email', coalesce(v_speaker.invite_email, ''),
            'status', v_speaker.status
        ),
        'token_expires_at', v_speaker.invite_token_expires_at
    );
end;
$$;

grant execute on function public.fn_event_speaker_resolve_by_token(uuid) to anon, authenticated;

-- Save speaker profile via token. Marks status='profile_complete', clears token.
create or replace function public.fn_event_speaker_save_by_token(
    p_token             uuid,
    p_display_name      text,
    p_title             text,
    p_company           text,
    p_bio               text,
    p_photo_path        text,
    p_talk_title        text,
    p_talk_description  text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_speaker record;
begin
    if p_token is null then
        return jsonb_build_object('ok', false, 'error', 'no_token');
    end if;
    if p_display_name is null or length(trim(p_display_name)) = 0 then
        return jsonb_build_object('ok', false, 'error', 'name_required');
    end if;

    select * into v_speaker
      from public.event_speakers
     where invite_token = p_token
     limit 1;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'token_not_found');
    end if;
    if v_speaker.invite_token_expires_at is not null
       and v_speaker.invite_token_expires_at < now() then
        return jsonb_build_object('ok', false, 'error', 'token_expired');
    end if;
    if v_speaker.status not in ('invited','profile_complete') then
        return jsonb_build_object('ok', false, 'error', 'speaker_status_locked',
            'status', v_speaker.status);
    end if;

    update public.event_speakers
       set display_name       = coalesce(nullif(trim(p_display_name), ''), display_name),
           title              = nullif(trim(p_title), ''),
           company            = nullif(trim(p_company), ''),
           bio                = nullif(trim(p_bio), ''),
           photo_path         = nullif(trim(p_photo_path), ''),
           talk_title         = nullif(trim(p_talk_title), ''),
           talk_description   = nullif(trim(p_talk_description), ''),
           status             = 'profile_complete',
           completed_via_token = true,
           completed_at       = now(),
           invite_token       = null,    -- one-time-use: clear
           updated_at         = now()
     where id = v_speaker.id;

    return jsonb_build_object(
        'ok', true,
        'message', 'Profile saved. The event organizer will review and publish your bio shortly.'
    );
end;
$$;

grant execute on function public.fn_event_speaker_save_by_token(uuid, text, text, text, text, text, text, text) to anon, authenticated;

-- ---------- 6. Storage bucket for speaker photos --------------------------
-- 'event-speakers' is public-readable (photos appear on the public event page).
-- Insert is gated by RLS on storage.objects (handled separately in the
-- Supabase dashboard or via the create_bucket RPC). Documented as TODO.
do $$
begin
    if not exists (select 1 from storage.buckets where id = 'event-speakers') then
        insert into storage.buckets (id, name, public)
        values ('event-speakers', 'event-speakers', true);
    end if;
exception
    when others then
        raise notice 'Could not create event-speakers bucket automatically (likely missing role). Create it manually in Supabase Dashboard → Storage → New bucket (public).';
end$$;

-- ---------- 7. Seed: the September 12 LYMX launch event ------------------
-- One row mirrors what launch-event.html currently hardcodes. After this
-- migration, launch-event.html reads from this row instead.
insert into public.events (slug, title, subtitle, description_md, event_at, end_at,
                            timezone, location_name, location_address, capacity,
                            status, published_at)
values (
    'lymx-launch-25',
    'LYMX Public Launch · Las Vegas',
    'September 12, 2026 — meet the team, try the network, see Launch 25 in action',
    'Public launch of the LYMX rewards network. Customers can sign up at the door, try the network with $10 of free LYMX, and meet the founding Businesses + Partners. Press registration desk on arrival; Founder Q&A at 1 PM.',
    '2026-09-12 11:00:00 -07',
    '2026-09-12 16:00:00 -07',
    'America/Los_Angeles',
    'Container Park',
    '707 Fremont St, Las Vegas, NV 89101',
    500,
    'published',
    now()
)
on conflict (slug) do nothing;

-- Seed the 4 hardcoded speakers from the current launch-event.html
do $$
declare v_event_id uuid;
begin
    select id into v_event_id from public.events where slug = 'lymx-launch-25';
    if v_event_id is null then return; end if;

    insert into public.event_speakers
        (event_id, display_name, title, company, status, sort_order)
    values
        (v_event_id, 'Kenny Lin',      'Founder & CEO',         'LYMX Power',            'published', 10),
        (v_event_id, 'Sienna Vega',    'Master Partner',        'Las Vegas territory',   'published', 20),
        (v_event_id, 'Daniel Whitley', 'Owner, Brew & Bean',    'Launch 25 Business #2', 'published', 30),
        (v_event_id, 'Maria Lopez',    'Owner, Oakline Kitchen','Launch 25 Business #5', 'published', 40)
    on conflict do nothing;
end$$;

commit;

-- After applying:
--   1. Verify storage bucket 'event-speakers' exists + is public (Supabase
--      Dashboard → Storage). If the bucket auto-create failed, create it
--      manually: name='event-speakers', public=true.
--   2. Confirm the seed row exists:  SELECT * FROM events WHERE slug='lymx-launch-25';
--   3. The frontend pages (admin-events.html, admin-event-edit.html,
--      event-speaker-edit.html, launch-event.html) ship in the same push.
