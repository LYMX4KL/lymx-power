-- Migration 030: reviews + saved_businesses tables + review->LYMX bonus
-- ---------------------------------------------------------------------------
-- Creates the two core engagement tables we have been writing UI for but
-- which did not yet exist in the database.
--   * reviews — customer reviews of businesses, 100 LYMX bonus per published review
--   * saved_businesses — customer "save for later" list, surfaces on dashboard
-- Adds an after-insert trigger on reviews that auto-issues 100 LYMX to the reviewer
-- via the existing lymx_issuances table (created in migration 012).
-- Applied 2026-05-16.

-- ===== reviews ============================================================
CREATE TABLE IF NOT EXISTS public.reviews (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  business_slug    text,                    -- biz-brew-and-bean, etc.
  business_name    text NOT NULL,
  rating           int  NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body             text NOT NULL CHECK (length(trim(body)) >= 10),
  has_photo        boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewer ON public.reviews(reviewer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_business ON public.reviews(business_slug, created_at DESC);

ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reviews_public_read ON public.reviews;
CREATE POLICY reviews_public_read ON public.reviews FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS reviews_own_insert ON public.reviews;
CREATE POLICY reviews_own_insert ON public.reviews FOR INSERT TO authenticated WITH CHECK (reviewer_user_id = auth.uid());
DROP POLICY IF EXISTS reviews_own_update ON public.reviews;
CREATE POLICY reviews_own_update ON public.reviews FOR UPDATE TO authenticated USING (reviewer_user_id = auth.uid()) WITH CHECK (reviewer_user_id = auth.uid());
DROP POLICY IF EXISTS reviews_own_delete ON public.reviews;
CREATE POLICY reviews_own_delete ON public.reviews FOR DELETE TO authenticated USING (reviewer_user_id = auth.uid());

-- ===== Review->LYMX bonus trigger ========================================
-- 100 LYMX per published review, once per reviewer per business.
CREATE OR REPLACE FUNCTION public.fn_award_review_lymx()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  already_issued bigint;
BEGIN
  SELECT COUNT(*) INTO already_issued
    FROM public.lymx_issuances
   WHERE recipient_user_id = NEW.reviewer_user_id
     AND source = 'review'
     AND meta->>'business_slug' = NEW.business_slug
     AND meta->>'review_id'     = NEW.id::text;
  IF already_issued > 0 THEN RETURN NEW; END IF;
  INSERT INTO public.lymx_issuances (recipient_user_id, amount, source, meta)
  VALUES (NEW.reviewer_user_id, 100, 'review',
          jsonb_build_object('review_id', NEW.id, 'business_slug', NEW.business_slug, 'business_name', NEW.business_name));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_award_review_lymx ON public.reviews;
CREATE TRIGGER trg_award_review_lymx AFTER INSERT ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.fn_award_review_lymx();

-- ===== saved_businesses ===================================================
CREATE TABLE IF NOT EXISTS public.saved_businesses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  business_slug    text NOT NULL,
  business_name    text NOT NULL,
  business_emoji   text,
  saved_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, business_slug)
);
CREATE INDEX IF NOT EXISTS idx_saved_user ON public.saved_businesses(user_id, saved_at DESC);

ALTER TABLE public.saved_businesses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saved_own_all ON public.saved_businesses;
CREATE POLICY saved_own_all ON public.saved_businesses FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

SELECT 'migration 030 applied' AS status,
       (SELECT COUNT(*) FROM pg_policies WHERE tablename IN ('reviews','saved_businesses')) AS new_policies;
