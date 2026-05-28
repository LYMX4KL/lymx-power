-- =============================================================================
-- #1 — Partner leaderboard name visibility (named by default, opt-out)
-- =============================================================================
-- Adds an opt-OUT flag so a partner can hide their name on the partner
-- leaderboard. Default TRUE = current behavior (named) is preserved for every
-- existing partner; turning it off shows them as "Anonymous · <Tier>" instead.
--
-- Run this in the Supabase SQL editor for project apffootxzfwmtyjlnteo.
-- Safe to re-run (idempotent).
-- =============================================================================

-- 1) The flag. Default true => no visible change for anyone until they opt out.
ALTER TABLE public.partners
  ADD COLUMN IF NOT EXISTS show_on_leaderboard boolean NOT NULL DEFAULT true;

-- 2) Self-service toggle via SECURITY DEFINER RPC.
--    We deliberately do NOT add a broad partner self-UPDATE RLS policy, because
--    that would let a partner edit ANY column on their row (is_founding_25,
--    signup_fee_waived, etc.) through PostgREST. This RPC updates ONLY the
--    show_on_leaderboard flag for the calling user's own partner row.
CREATE OR REPLACE FUNCTION public.set_partner_leaderboard_visibility(p_show boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_rows int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  UPDATE public.partners
     SET show_on_leaderboard = COALESCE(p_show, true),
         updated_at = now()
   WHERE user_id = v_uid;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'No partner record for the current user';
  END IF;
  RETURN COALESCE(p_show, true);
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.set_partner_leaderboard_visibility(boolean) TO authenticated;
