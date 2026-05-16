-- Migration 029: contacts table — allow owners to update + delete their own rows
-- ---------------------------------------------------------------------------
-- Bug #4e45b65f (Dave 2026-05-15): "Editing Contact Displays Error Upon Form Submission"
-- Cause: contacts table has INSERT + SELECT policies for owner_id = auth.uid()
-- but is missing the UPDATE and DELETE policies, so PATCH from the edit modal
-- gets blocked by RLS.
-- Fix: add the two policies, gated on owner_id = auth.uid().
-- Applied 2026-05-16.

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contacts_owner_update ON public.contacts;
CREATE POLICY contacts_owner_update ON public.contacts
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS contacts_owner_delete ON public.contacts;
CREATE POLICY contacts_owner_delete ON public.contacts
  FOR DELETE TO authenticated
  USING (owner_id = auth.uid());

SELECT 'migration 029 applied' AS status,
       (SELECT COUNT(*) FROM pg_policies WHERE tablename = 'contacts') AS policies_on_contacts;
