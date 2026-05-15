-- Migration 028: partner_invites — allow partners to insert their own invite rows
-- ---------------------------------------------------------------------------
-- Bug #e0441aec (Dave Bacay 2026-05-15): "Invite Friends email send fails with 403"
-- Cause: SELECT works because partners can read their own invites, but INSERT
-- was admin-only (or missing) so the row create from admin-invite-friends.html
-- throws 403 before we even reach broadcast-send.
--
-- Fix: add a policy that lets any authenticated user insert a row where
-- sender_id = auth.uid(). Read/update policies stay restrictive.
--
-- Applied to Supabase on 2026-05-15.

ALTER TABLE public.partner_invites ENABLE ROW LEVEL SECURITY;

-- Insert: any authenticated user can insert THEIR OWN invites
DROP POLICY IF EXISTS partner_invites_self_insert ON public.partner_invites;
CREATE POLICY partner_invites_self_insert ON public.partner_invites
  FOR INSERT TO authenticated
  WITH CHECK (sender_id = auth.uid());

-- Select: senders see their own rows; admin sees everything
DROP POLICY IF EXISTS partner_invites_self_read ON public.partner_invites;
CREATE POLICY partner_invites_self_read ON public.partner_invites
  FOR SELECT TO authenticated
  USING (
    sender_id = auth.uid()
    OR auth.uid() = '1405bb50-2c97-48dd-bfa5-31f32320de9b'
  );

-- Update: only sender can update their own row (e.g. mark resent), admin can update any
DROP POLICY IF EXISTS partner_invites_self_update ON public.partner_invites;
CREATE POLICY partner_invites_self_update ON public.partner_invites
  FOR UPDATE TO authenticated
  USING (
    sender_id = auth.uid()
    OR auth.uid() = '1405bb50-2c97-48dd-bfa5-31f32320de9b'
  );

SELECT 'migration 028 applied' AS status,
       (SELECT COUNT(*) FROM pg_policies WHERE tablename = 'partner_invites') AS policies_on_partner_invites;
