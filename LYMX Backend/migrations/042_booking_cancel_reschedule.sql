-- =============================================================================
-- Migration 042 — Booking cancel + reschedule flow
-- =============================================================================
-- Adds a public token so the booker (or anyone with the email link) can cancel
-- or reschedule without needing to be signed in to LYMX.
-- =============================================================================

alter table public.bookings
    add column if not exists cancel_token text default uuid_generate_v4()::text,
    add column if not exists cancelled_at timestamptz,
    add column if not exists cancelled_by text,
    add column if not exists cancelled_reason text,
    add column if not exists rescheduled_from_booking_id uuid references public.bookings(id);

update public.bookings
   set cancel_token = coalesce(cancel_token, gen_random_uuid()::text)
 where cancel_token is null;

create index if not exists idx_bookings_cancel_token on public.bookings(cancel_token);


create or replace function public.fn_validate_booking_cancel_token(
    p_booking_id uuid,
    p_token text
)
returns table (
    booking_id uuid,
    starts_at  timestamptz,
    ends_at    timestamptz,
    status     text,
    handle     text,
    display_name text,
    booker_name text,
    booker_email text,
    timezone   text
)
language plpgsql
security definer
set search_path = public
as $$
begin
    return query
    select b.id, b.starts_at, b.ends_at, b.status::text, tc.handle, tc.display_name,
           b.booker_name, b.booker_email, tc.timezone
      from public.bookings b
      join public.team_calendars tc on tc.id = b.team_calendar_id
     where b.id = p_booking_id
       and b.cancel_token = p_token;
end;
$$;

grant execute on function public.fn_validate_booking_cancel_token(uuid, text) to anon, authenticated;


-- Google revoke handling
alter table public.oauth_tokens
    add column if not exists status text not null default 'active';


-- Booking reminder tracking (T-24h and T-1h)
alter table public.bookings
    add column if not exists reminder_24h_sent_at timestamptz,
    add column if not exists reminder_1h_sent_at  timestamptz;

create index if not exists idx_bookings_starts_at_status on public.bookings(starts_at, status);


select 'migration 042 applied' as status,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='bookings'
           and column_name in ('cancel_token','cancelled_at','cancelled_by','cancelled_reason','rescheduled_from_booking_id','reminder_24h_sent_at','reminder_1h_sent_at')
       ) as bookings_columns_added,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='oauth_tokens' and column_name='status'
       ) as oauth_status_added,
       (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='fn_validate_booking_cancel_token'
       ) as rpc_present;
