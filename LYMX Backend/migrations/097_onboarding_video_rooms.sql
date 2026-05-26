-- =============================================================================
-- Migration 097 — Module 4 of biz-onboarding roadmap: Video rooms for onboarding calls
-- =============================================================================
-- Per audit § Step 5 / Module 4. The team-calendar `bookings` table already
-- carries `video_room_id`, `video_room_url`, `video_room_data` JSONB so
-- Daily.co webhooks (handled by the call-summary EF) can correlate a meeting
-- event back to the booking row. We mirror that shape onto onboarding_bookings
-- so the same flow works for biz-onboarding calls.
--
-- Columns added:
--   - video_room_id    text    — short room name (matches Daily.co room.name OR a
--                                meet.jit.si slug when DAILY_API_KEY isn't set).
--   - video_room_url   text    — full URL the booker + host click to join.
--   - video_room_data  jsonb   — provider metadata + post-call payloads (room
--                                created data, meeting.ended event, transcript
--                                URL, etc.). Starts as {} and accretes events.
--
-- These are written by the new `onboarding-room-create` EF (Module 4) when a
-- prospect confirms a booking via book-onboarding-call.html. The call-summary
-- EF will be extended in this module to also look up onboarding_bookings by
-- video_room_id when its Daily webhook fires.
-- =============================================================================

BEGIN;

ALTER TABLE public.onboarding_bookings
    ADD COLUMN IF NOT EXISTS video_room_id   text,
    ADD COLUMN IF NOT EXISTS video_room_url  text,
    ADD COLUMN IF NOT EXISTS video_room_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS completed_at    timestamptz;

CREATE INDEX IF NOT EXISTS onboarding_bookings_video_room_idx
    ON public.onboarding_bookings(video_room_id)
    WHERE video_room_id IS NOT NULL;

COMMENT ON COLUMN public.onboarding_bookings.video_room_id IS
  'Short room identifier (matches Daily.co room.name OR a meet.jit.si slug when DAILY_API_KEY is absent). Used by the call-summary EF to correlate Daily webhook events back to this booking.';
COMMENT ON COLUMN public.onboarding_bookings.video_room_url IS
  'Full URL the booker + host click to join the call. Sent in the confirmation email + included in the ICS attachment.';
COMMENT ON COLUMN public.onboarding_bookings.video_room_data IS
  'Provider metadata + post-call payloads. Starts as {}; accretes the room create response, meeting.ended event, transcript URL, etc.';
COMMENT ON COLUMN public.onboarding_bookings.completed_at IS
  'Timestamp the call ended (set by call-summary EF on Daily.co room.meeting.ended). NULL while the call is still upcoming.';

-- ─── Sanity ────────────────────────────────────────────────────────────────
DO $sanity_097$
DECLARE
    v_cols int;
BEGIN
    SELECT count(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='onboarding_bookings'
       AND column_name IN ('video_room_id','video_room_url','video_room_data','completed_at')
    INTO v_cols;
    RAISE NOTICE 'Module 4 migration 097: onboarding_bookings video cols=%/4', v_cols;
    IF v_cols <> 4 THEN
        RAISE EXCEPTION 'Migration 097 failed: expected 4 new columns, got %', v_cols;
    END IF;
END $sanity_097$;

COMMIT;
