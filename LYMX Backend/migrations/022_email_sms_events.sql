-- =============================================================================
-- Migration 022 — Email events + SMS message log
-- =============================================================================
-- Mirrors InvestPro 154_email_events (Resend webhook -> event log) and
-- InvestPro 050_service_messages (Twilio SMS audit) so LYMX has the same
-- observability + outreach surface area.
--
-- Tables:
--   - email_sends        : one row per outbound email (Resend send result)
--   - email_events       : delivery / open / bounce / complaint events
--                          posted by Resend webhook -> linked to email_sends
--   - sms_messages       : outbound + inbound SMS log (Twilio)
--
-- Compatible with prior migrations. Idempotent.
-- =============================================================================

-- =====================================================================
-- 1. email_sends — one row per outbound email
-- =====================================================================
create table if not exists public.email_sends (
    id                  uuid primary key default uuid_generate_v4(),
    -- Linkage
    broadcast_id        uuid references public.broadcasts(id) on delete set null,
    feedback_id         uuid references public.feedback(id) on delete set null,
    sender_user_id      uuid references auth.users(id) on delete set null,
    -- Send metadata
    from_address        text not null,
    reply_to            text,
    to_address          text not null,
    subject             text,
    template_key        text,
    -- Resend response
    resend_message_id   text unique,           -- the id returned by Resend
    send_status         text not null default 'queued' check (send_status in ('queued','sent','failed')),
    error_message       text,
    -- Audit
    created_at          timestamptz not null default now(),
    sent_at             timestamptz
);

create index if not exists idx_email_sends_to       on public.email_sends(lower(to_address));
create index if not exists idx_email_sends_resend   on public.email_sends(resend_message_id);
create index if not exists idx_email_sends_bcast    on public.email_sends(broadcast_id);
create index if not exists idx_email_sends_sender   on public.email_sends(sender_user_id);
create index if not exists idx_email_sends_created  on public.email_sends(created_at desc);

alter table public.email_sends enable row level security;

-- Admin reads everything; others read their own sends only
drop policy if exists email_sends_admin_all on public.email_sends;
create policy email_sends_admin_all on public.email_sends
    for select to authenticated
    using (
        auth.uid() = '1405bb50-2c97-48dd-bfa5-31f32320de9b'::uuid
        or sender_user_id = auth.uid()
    );

-- Inserts only by service role (no authenticated INSERT policy)


-- =====================================================================
-- 2. email_events — per-event log from Resend webhook
-- =====================================================================
-- Resend event types: email.sent, email.delivered, email.delivery_delayed,
-- email.complained, email.bounced, email.opened, email.clicked.
create table if not exists public.email_events (
    id                  uuid primary key default uuid_generate_v4(),
    email_send_id       uuid references public.email_sends(id) on delete cascade,
    resend_message_id   text not null,           -- the join key when send row missing
    event_type          text not null,           -- 'sent' | 'delivered' | 'opened' | 'clicked' | 'bounced' | 'complained' | 'delivery_delayed'
    to_address          text,
    user_agent          text,
    click_url           text,                    -- for 'clicked' events
    bounce_reason       text,                    -- for 'bounced'
    raw_payload         jsonb,                   -- whole webhook body
    occurred_at         timestamptz not null default now()
);

create index if not exists idx_email_events_send_id  on public.email_events(email_send_id);
create index if not exists idx_email_events_msg_id   on public.email_events(resend_message_id);
create index if not exists idx_email_events_type     on public.email_events(event_type);
create index if not exists idx_email_events_when     on public.email_events(occurred_at desc);

alter table public.email_events enable row level security;

drop policy if exists email_events_admin_all on public.email_events;
create policy email_events_admin_all on public.email_events
    for select to authenticated
    using (
        auth.uid() = '1405bb50-2c97-48dd-bfa5-31f32320de9b'::uuid
        or exists (
            select 1 from public.email_sends s
             where s.id = email_events.email_send_id
               and s.sender_user_id = auth.uid()
        )
    );


-- =====================================================================
-- 3. Convenience denormalized status columns on email_sends
-- =====================================================================
alter table public.email_sends
    add column if not exists delivered_at  timestamptz,
    add column if not exists opened_at     timestamptz,
    add column if not exists clicked_at    timestamptz,
    add column if not exists bounced_at    timestamptz,
    add column if not exists complained_at timestamptz;

-- When an email_event lands, bump the denormalized columns
create or replace function public.email_events_bump_send()
returns trigger
language plpgsql
security definer
as $$
declare
    v_send_id uuid;
begin
    -- Resolve send_id from resend_message_id if missing
    v_send_id := new.email_send_id;
    if v_send_id is null and new.resend_message_id is not null then
        select id into v_send_id from public.email_sends where resend_message_id = new.resend_message_id;
        new.email_send_id := v_send_id;
    end if;

    if v_send_id is null then
        return new;
    end if;

    update public.email_sends s set
        delivered_at  = coalesce(s.delivered_at,  case when new.event_type = 'delivered'        then new.occurred_at end),
        opened_at     = coalesce(s.opened_at,     case when new.event_type = 'opened'           then new.occurred_at end),
        clicked_at    = coalesce(s.clicked_at,    case when new.event_type = 'clicked'          then new.occurred_at end),
        bounced_at    = coalesce(s.bounced_at,    case when new.event_type = 'bounced'          then new.occurred_at end),
        complained_at = coalesce(s.complained_at, case when new.event_type = 'complained'       then new.occurred_at end)
      where s.id = v_send_id;
    return new;
end;
$$;

drop trigger if exists trg_email_events_bump on public.email_events;
create trigger trg_email_events_bump
    before insert on public.email_events
    for each row execute function public.email_events_bump_send();


-- =====================================================================
-- 4. sms_messages — Twilio SMS log (outbound + inbound)
-- =====================================================================
-- Direction:
--   outbound — staff/system sent to a customer/partner
--   inbound  — customer/partner replied to our Twilio number
--   proxy_a_to_b / proxy_b_to_a — masked-pair relay (future)
create table if not exists public.sms_messages (
    id                  uuid primary key default uuid_generate_v4(),
    -- Linkage
    sender_user_id      uuid references auth.users(id) on delete set null,
    recipient_user_id   uuid references auth.users(id) on delete set null,  -- optional resolve
    broadcast_id        uuid references public.broadcasts(id) on delete set null,
    feedback_id         uuid references public.feedback(id) on delete set null,
    -- Numbers
    from_number         text not null,
    to_number           text not null,
    -- Content
    body                text not null,
    media_urls          jsonb default '[]'::jsonb,
    -- Direction
    direction           text not null check (direction in ('outbound','inbound','proxy_a_to_b','proxy_b_to_a')),
    -- Twilio metadata
    twilio_sid          text unique,
    send_status         text not null default 'queued' check (send_status in ('queued','sent','delivered','failed','received')),
    error_code          text,
    error_message       text,
    -- Audit
    created_at          timestamptz not null default now(),
    delivered_at        timestamptz
);

create index if not exists idx_sms_messages_to        on public.sms_messages(to_number);
create index if not exists idx_sms_messages_from      on public.sms_messages(from_number);
create index if not exists idx_sms_messages_sid       on public.sms_messages(twilio_sid);
create index if not exists idx_sms_messages_user      on public.sms_messages(sender_user_id);
create index if not exists idx_sms_messages_created   on public.sms_messages(created_at desc);

alter table public.sms_messages enable row level security;

drop policy if exists sms_messages_admin_all on public.sms_messages;
create policy sms_messages_admin_all on public.sms_messages
    for select to authenticated
    using (
        auth.uid() = '1405bb50-2c97-48dd-bfa5-31f32320de9b'::uuid
        or sender_user_id    = auth.uid()
        or recipient_user_id = auth.uid()
    );


-- =====================================================================
-- 5. Verify
-- =====================================================================
select 'migration 022 applied' as status,
       (select count(*) from information_schema.tables
         where table_schema='public' and table_name in ('email_sends','email_events','sms_messages')) as new_tables_present,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='email_sends'
           and column_name in ('delivered_at','opened_at','clicked_at','bounced_at','complained_at')) as denormalized_cols_present;
