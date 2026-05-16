-- Migration 031: gate reviews behind transaction verification
-- ---------------------------------------------------------------------------
-- Locks the product rule (2026-05-16): every review on LYMX must be backed
-- by a real transaction. Two acceptable proofs:
--
--   1. transaction_id — references public.transactions (the LYMX ledger).
--      Auto-verified at insert. Used when business has POS integration
--      (Square/Toast) and we have a ledger row of type 'issuance' for this
--      customer's wallet at this business.
--
--   2. receipt_image_url — link to a user-uploaded receipt photo stored
--      in Supabase Storage bucket 'review-receipts'. Pending until an
--      admin reviews and approves; 100 LYMX trigger fires only after
--      verification_status = 'verified'.
--
-- Either pathway is acceptable. Reviews with neither are rejected.
--
-- The 100 LYMX bonus is now conditional on verification_status = 'verified'.
-- Public read continues to surface only verified reviews.
-- ---------------------------------------------------------------------------

-- ===== 1. enum for verification state =====================================
DO $$ BEGIN
  CREATE TYPE review_verification_status AS ENUM ('pending', 'verified', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===== 2. add the verification columns ====================================
ALTER TABLE public.reviews
  ADD COLUMN IF NOT EXISTS transaction_id      uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS receipt_image_url   text,
  ADD COLUMN IF NOT EXISTS verification_status review_verification_status NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS verified_by_user_id uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS verified_at         timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason    text;

CREATE INDEX IF NOT EXISTS idx_reviews_transaction ON public.reviews(transaction_id);
CREATE INDEX IF NOT EXISTS idx_reviews_verification ON public.reviews(verification_status, created_at DESC);

-- ===== 3. require either transaction_id OR receipt_image_url ==============
-- (drop first in case migration is re-run with refined logic)
ALTER TABLE public.reviews DROP CONSTRAINT IF EXISTS reviews_proof_required;
ALTER TABLE public.reviews
  ADD CONSTRAINT reviews_proof_required
  CHECK (transaction_id IS NOT NULL OR receipt_image_url IS NOT NULL);

-- ===== 4. auto-verify when transaction_id is provided + trusted ===========
-- Trigger runs BEFORE INSERT. If transaction_id is set AND the linked
-- transaction's wallet belongs to the reviewer, mark verified.
-- If only receipt_image_url is set, leave status 'pending' for admin review.
CREATE OR REPLACE FUNCTION public.fn_auto_verify_review()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  tx_wallet_owner uuid;
  tx_type         text;
BEGIN
  IF NEW.transaction_id IS NOT NULL THEN
    SELECT w.user_id, t.type::text
      INTO tx_wallet_owner, tx_type
      FROM public.transactions t
      JOIN public.wallets w ON w.id = t.wallet_id
     WHERE t.id = NEW.transaction_id;

    IF tx_wallet_owner IS NULL THEN
      RAISE EXCEPTION 'Transaction % not found', NEW.transaction_id;
    END IF;

    IF tx_wallet_owner <> NEW.reviewer_user_id THEN
      RAISE EXCEPTION 'Transaction % does not belong to reviewer %', NEW.transaction_id, NEW.reviewer_user_id;
    END IF;

    -- Only issuance/redemption count as proof of transacting at the biz.
    IF tx_type NOT IN ('issuance', 'redemption') THEN
      RAISE EXCEPTION 'Transaction type % is not valid proof of business activity', tx_type;
    END IF;

    NEW.verification_status := 'verified';
    NEW.verified_at         := now();
  END IF;
  -- Receipt-upload path stays 'pending' until admin verifies.
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_auto_verify_review ON public.reviews;
CREATE TRIGGER trg_auto_verify_review BEFORE INSERT ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.fn_auto_verify_review();

-- ===== 5. 100 LYMX trigger fires only on VERIFIED reviews =================
-- Replace the trigger from migration 030.
CREATE OR REPLACE FUNCTION public.fn_award_review_lymx()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  already_issued bigint;
BEGIN
  -- Only verified reviews earn LYMX.
  IF NEW.verification_status <> 'verified' THEN
    RETURN NEW;
  END IF;
  -- Did NOT just transition to verified? bail (prevents double-issue).
  IF TG_OP = 'UPDATE' AND OLD.verification_status = 'verified' THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO already_issued
    FROM public.lymx_issuances
   WHERE recipient_user_id = NEW.reviewer_user_id
     AND source            = 'review'
     AND meta->>'review_id' = NEW.id::text;
  IF already_issued > 0 THEN RETURN NEW; END IF;

  INSERT INTO public.lymx_issuances (recipient_user_id, amount, source, meta)
  VALUES (NEW.reviewer_user_id, 100, 'review',
          jsonb_build_object(
            'review_id',     NEW.id,
            'business_slug', NEW.business_slug,
            'business_name', NEW.business_name,
            'proof',         CASE WHEN NEW.transaction_id IS NOT NULL THEN 'transaction' ELSE 'receipt_upload' END
          ));
  RETURN NEW;
END $$;

-- Fire on INSERT (auto-verified path) AND on UPDATE when status flips to verified.
DROP TRIGGER IF EXISTS trg_award_review_lymx ON public.reviews;
CREATE TRIGGER trg_award_review_lymx
  AFTER INSERT OR UPDATE OF verification_status ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.fn_award_review_lymx();

-- ===== 6. public read only surfaces VERIFIED reviews ======================
-- Pending and rejected reviews remain readable by the reviewer (for "my
-- pending reviews" UI) and by admins, but anonymous visitors only see
-- verified ones on biz pages.
DROP POLICY IF EXISTS reviews_public_read ON public.reviews;
CREATE POLICY reviews_public_read ON public.reviews
  FOR SELECT TO anon, authenticated
  USING (verification_status = 'verified' OR reviewer_user_id = auth.uid());

-- Admin read-all (uses staff_roles from migration 015)
DROP POLICY IF EXISTS reviews_admin_read ON public.reviews;
CREATE POLICY reviews_admin_read ON public.reviews
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.staff_roles sr
     WHERE sr.user_id = auth.uid()
       AND sr.role IN ('admin', 'cfo', 'cto')
       AND sr.active
  ));

-- Admin can flip verification_status on pending reviews.
DROP POLICY IF EXISTS reviews_admin_verify ON public.reviews;
CREATE POLICY reviews_admin_verify ON public.reviews
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.staff_roles sr
     WHERE sr.user_id = auth.uid()
       AND sr.role IN ('admin', 'cfo', 'cto')
       AND sr.active
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.staff_roles sr
     WHERE sr.user_id = auth.uid()
       AND sr.role IN ('admin', 'cfo', 'cto')
       AND sr.active
  ));

-- ===== 7. helper RPC: list my recent transactions at a business ==========
-- Used by the biz-page review form to populate the "select a recent
-- receipt" picker. Returns transactions for the calling user matching
-- the business_name string the page passes in. The biz_partners and
-- businesses tables aren't joined yet (separate concepts as of 031);
-- we match by display name and biz_partners.slug attribution where
-- available.
CREATE OR REPLACE FUNCTION public.my_recent_tx_at_business(p_business_slug text, p_business_name text DEFAULT NULL)
RETURNS TABLE(
  transaction_id  uuid,
  type            text,
  lymx_amount     numeric,
  usd_basis       numeric,
  created_at      timestamptz
) LANGUAGE sql SECURITY DEFINER AS $$
  SELECT t.id, t.type::text, t.lymx_amount, t.usd_basis, t.created_at
    FROM public.transactions t
    JOIN public.wallets   w ON w.id = t.wallet_id
    JOIN public.businesses b ON b.id = t.business_id
   WHERE w.user_id = auth.uid()
     AND (
          (p_business_name IS NOT NULL AND (b.legal_name = p_business_name OR b.display_name = p_business_name))
       OR b.legal_name   = p_business_slug
       OR b.display_name = p_business_slug
     )
     AND t.type IN ('issuance', 'redemption')
     AND t.created_at >= now() - interval '90 days'
   ORDER BY t.created_at DESC
   LIMIT 20;
$$;

GRANT EXECUTE ON FUNCTION public.my_recent_tx_at_business(text, text) TO authenticated;

-- ===== 8. Supabase Storage bucket for receipt uploads ====================
-- Bucket 'review-receipts' — users upload receipt photos here when they
-- don't have a ledger transaction. Path convention:
--   review-receipts/<auth.uid()>/<random-uuid>.jpg
-- RLS: a user can upload only to their own folder; reviewers can read
-- their own; admins can read all.

INSERT INTO storage.buckets (id, name, public)
VALUES ('review-receipts', 'review-receipts', false)
ON CONFLICT (id) DO NOTHING;

-- User can upload into their own folder.
DROP POLICY IF EXISTS receipt_upload_own ON storage.objects;
CREATE POLICY receipt_upload_own ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'review-receipts'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- User can read their own receipt photos.
DROP POLICY IF EXISTS receipt_read_own ON storage.objects;
CREATE POLICY receipt_read_own ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'review-receipts'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Admin can read all receipt photos (for verification queue).
DROP POLICY IF EXISTS receipt_read_admin ON storage.objects;
CREATE POLICY receipt_read_admin ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'review-receipts'
    AND EXISTS (
      SELECT 1 FROM public.staff_roles sr
       WHERE sr.user_id = auth.uid()
         AND sr.role IN ('admin', 'cfo', 'cto')
         AND sr.active
    )
  );

-- ===== 9. result ===========================================================
SELECT 'migration 031 applied' AS status,
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_schema='public' AND table_name='reviews'
           AND column_name IN ('transaction_id','receipt_image_url','verification_status')) AS new_columns,
       (SELECT COUNT(*) FROM pg_policies WHERE tablename='reviews') AS total_policies_on_reviews,
       (SELECT COUNT(*) FROM storage.buckets WHERE id='review-receipts') AS bucket_exists;
