-- Migration 027: feedback attachments table + storage bucket
-- ---------------------------------------------------------------------
-- The Send Feedback widget now supports drag-drop / paste / multi-upload
-- of files in addition to the auto-captured screenshot. Each ticket can
-- have up to 6 supplementary attachments stored in the
-- "feedback-attachments" bucket. This migration creates the table and
-- the bucket (idempotent).

CREATE TABLE IF NOT EXISTS public.feedback_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id uuid NOT NULL REFERENCES public.feedback(id) ON DELETE CASCADE,
  file_name   text NOT NULL,
  mime_type   text,
  size_bytes  bigint,
  storage_path text NOT NULL,
  uploaded_by uuid REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fb_att_feedback ON public.feedback_attachments(feedback_id);

ALTER TABLE public.feedback_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fb_att_submitter_read ON public.feedback_attachments;
CREATE POLICY fb_att_submitter_read ON public.feedback_attachments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.feedback f
       WHERE f.id = feedback_attachments.feedback_id
         AND f.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS fb_att_admin_all ON public.feedback_attachments;
CREATE POLICY fb_att_admin_all ON public.feedback_attachments
  FOR ALL TO authenticated
  USING (public.am_i_admin())
  WITH CHECK (public.am_i_admin());

-- Storage bucket (private — served via signed URLs from admin pages)
INSERT INTO storage.buckets (id, name, public)
VALUES ('feedback-attachments', 'feedback-attachments', false)
ON CONFLICT (id) DO NOTHING;

SELECT 'migration 027 applied' AS status,
       (SELECT COUNT(*) FROM public.feedback_attachments) AS existing_rows;
