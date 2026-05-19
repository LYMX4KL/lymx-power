-- =============================================================================
-- Migration 043 — Post-call follow-up reminder
-- =============================================================================
-- Adds a `follow_up_sent_at` column on bookings so the booking-reminders cron
-- can fire a T+24h email to the team-calendar owner with the AI call summary
-- + "follow up now" CTA. One reminder per booking, idempotent.
-- =============================================================================

alter table public.bookings
    add column if not exists follow_up_sent_at timestamptz;

create index if not exists idx_bookings_completed_followup
    on public.bookings(completed_at)
    where status = 'completed' and follow_up_sent_at is null;


select 'migration 043 applied' as status,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='bookings' and column_name='follow_up_sent_at'
       ) as column_added;
