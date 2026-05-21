-- Migration 070: Backfill awaiting_verification=false on tickets whose
-- verification token has already been used.
--
-- Root cause: the feedback-verify EF marks verification_token_used_at on
-- success but did NOT also flip awaiting_verification to false, so the
-- "Yes, it works" / "Still broken" buttons keep rendering on /my-feedback.html.
-- A second click on a still-visible button hits the EF with an already-used
-- token and returns 403 "Invalid token", which the UI shows as
-- "Could not record your response."
--
-- Sweep (run 2026-05-21, LYMX project apffootxzfwmtyjlnteo):
--   awaiting_verification = true  AND  verification_token_used_at IS NULL      ->  74 rows (healthy: fresh tokens)
--   awaiting_verification = true  AND  verification_token_used_at IS NOT NULL  ->  30 rows (STUCK: this backfill)
--
-- This migration ONLY heals existing stuck rows. The EF must also be patched
-- so future clicks set awaiting_verification = false in the same UPDATE.
-- See companion file: feedback-verify-patched.ts.

BEGIN;

-- Sanity peek before the update — log how many rows we're about to fix.
DO $sweep$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
  FROM public.feedback
  WHERE awaiting_verification = true
    AND verification_token_used_at IS NOT NULL;
  RAISE NOTICE '[070] About to clear awaiting_verification on % stuck rows', n;
END
$sweep$;

UPDATE public.feedback
   SET awaiting_verification = false,
       updated_at = now()
 WHERE awaiting_verification = true
   AND verification_token_used_at IS NOT NULL;

-- Post-update verification: should be 0 stuck rows remaining.
DO $verify$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
  FROM public.feedback
  WHERE awaiting_verification = true
    AND verification_token_used_at IS NOT NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION '[070] backfill failed: % stuck rows still present', n;
  END IF;
  RAISE NOTICE '[070] backfill complete — 0 stuck rows remaining';
END
$verify$;

COMMIT;
