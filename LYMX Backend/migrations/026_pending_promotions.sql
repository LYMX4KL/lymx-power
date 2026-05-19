-- Migration 026: Pending promotions for users who haven't signed up yet
-- ---------------------------------------------------------------------
-- Migration 025 tried to promote Helen Chen (helen0510c@gmail.com) to
-- admin + CFO, but she hadn't yet completed signup so the UPDATE matched
-- zero rows. This migration introduces a deferred-promotion table and
-- an auth.users INSERT trigger: when someone signs up with an email that
-- has a pending promotion, their staff_roles row is created automatically.
--
-- Applied to Supabase on 2026-05-15. Already includes Helen's pending
-- promotion row so the next time she signs up she becomes admin/CFO/HR.

CREATE TABLE IF NOT EXISTS public.pending_promotions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text UNIQUE NOT NULL,
  role         text NOT NULL DEFAULT 'admin',
  is_cfo       boolean DEFAULT false,
  is_hr        boolean DEFAULT false,
  job_title    text,
  notes        text,
  created_at   timestamptz DEFAULT now(),
  consumed_at  timestamptz
);

ALTER TABLE public.pending_promotions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pp_admin_all ON public.pending_promotions;
CREATE POLICY pp_admin_all ON public.pending_promotions
  FOR ALL TO authenticated
  USING (public.am_i_admin())
  WITH CHECK (public.am_i_admin());

INSERT INTO public.pending_promotions (email, role, is_cfo, is_hr, job_title, notes)
VALUES ('helen0510c@gmail.com', 'admin', true, true, 'Co-founder / CFO',
        'Co-founder. Full admin + CFO + HR access. Promoted automatically on signup.')
ON CONFLICT (email) DO UPDATE
  SET role = EXCLUDED.role,
      is_cfo = EXCLUDED.is_cfo,
      is_hr = EXCLUDED.is_hr,
      job_title = EXCLUDED.job_title,
      notes = EXCLUDED.notes;

CREATE OR REPLACE FUNCTION public.apply_pending_promotion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $fn$
DECLARE
  p public.pending_promotions%ROWTYPE;
BEGIN
  SELECT * INTO p
    FROM public.pending_promotions
   WHERE email = NEW.email AND consumed_at IS NULL
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.staff_roles (user_id, role, is_cfo, is_hr, job_title, granted_by, notes)
  VALUES (NEW.id, p.role, p.is_cfo, p.is_hr, p.job_title, NEW.id, p.notes)
  ON CONFLICT (user_id) DO UPDATE
    SET role = EXCLUDED.role,
        is_cfo = EXCLUDED.is_cfo,
        is_hr = EXCLUDED.is_hr,
        job_title = EXCLUDED.job_title,
        notes = EXCLUDED.notes;

  UPDATE public.pending_promotions
     SET consumed_at = now()
   WHERE id = p.id;

  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_apply_pending_promotion ON auth.users;
CREATE TRIGGER trg_apply_pending_promotion
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.apply_pending_promotion();

-- If the target user is already in auth.users (race / manual signup), promote now.
DO $$
DECLARE uid uuid;
BEGIN
  SELECT id INTO uid FROM auth.users WHERE email = 'helen0510c@gmail.com' LIMIT 1;
  IF uid IS NOT NULL THEN
    INSERT INTO public.staff_roles (user_id, role, is_cfo, is_hr, job_title, granted_by, notes)
    VALUES (uid, 'admin', true, true, 'Co-founder / CFO', uid, 'Promoted via migration 026 patch')
    ON CONFLICT (user_id) DO UPDATE
      SET role = 'admin', is_cfo = true, is_hr = true,
          job_title = 'Co-founder / CFO';
    UPDATE public.pending_promotions SET consumed_at = now()
     WHERE email = 'helen0510c@gmail.com';
  END IF;
END $$;

SELECT 'migration 026 applied' AS status,
       (SELECT COUNT(*) FROM public.pending_promotions WHERE consumed_at IS NULL) AS pending,
       (SELECT COUNT(*) FROM public.staff_roles WHERE role = 'admin') AS admins,
       (SELECT COUNT(*) FROM public.staff_roles WHERE is_cfo) AS cfos;
