-- =============================================================================
-- Migration 046 — Daily digest support
-- =============================================================================
-- Two columns on team_calendars to back the daily-digest EF:
--   * digest_send_hour — what local hour (0-23) the digest fires at. NULL/17 default.
--   * last_digest_date — the last local date a digest was sent. Idempotency gate
--     so the hourly cron doesn't double-send if it ran twice in the same hour.
-- =============================================================================

alter table public.team_calendars
    add column if not exists digest_send_hour smallint default 17,
    add column if not exists last_digest_date date;

-- Sanity bound the column so partners can't accidentally set garbage
alter table public.team_calendars
    drop constraint if exists team_calendars_digest_hour_range;
alter table public.team_calendars
    add constraint team_calendars_digest_hour_range
    check (digest_send_hour is null or (digest_send_hour >= 0 and digest_send_hour <= 23));

select 'migration 046 applied' as status,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='team_calendars'
           and column_name in ('digest_send_hour','last_digest_date')
       ) as cols_added;
