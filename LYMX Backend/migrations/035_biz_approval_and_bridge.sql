-- Migration 035: business approval workflow + bridge to business_partners
-- ---------------------------------------------------------------------------
-- Built 2026-05-17. Closes the gap found in the biz-signup audit:
--   * biz-signup.html writes to public.businesses
--   * welcome.html?biz=<slug> reads from public.business_partners
--   * Nothing bridges them, so a self-serve biz signup doesn't get a working
--     customer landing URL.
--
-- This migration:
--   1. Adds approval state to public.businesses (pending/approved/rejected).
--   2. Adds a slug column to public.businesses (auto-generated from display_name).
--   3. AFTER INSERT trigger on public.businesses creates a matching
--      public.business_partners row using the same slug, so welcome.html
--      works immediately after signup.
--   4. Idempotency: ON CONFLICT (slug) DO NOTHING on the bridge insert.
-- ---------------------------------------------------------------------------

-- ===== 1. approval_status enum + columns ==================================
DO $$ BEGIN
  CREATE TYPE biz_approval_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS slug              text,
  ADD COLUMN IF NOT EXISTS approval_status   biz_approval_status NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS approved_at       timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by       uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS rejection_reason  text;

CREATE INDEX IF NOT EXISTS idx_businesses_approval ON public.businesses(approval_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_businesses_slug     ON public.businesses(slug);

-- Make slug unique-when-not-null (some legacy rows may have NULL)
DROP INDEX IF EXISTS uniq_businesses_slug;
CREATE UNIQUE INDEX uniq_businesses_slug ON public.businesses(slug) WHERE slug IS NOT NULL;

-- ===== 2. slug generation helper =========================================
CREATE OR REPLACE FUNCTION public.fn_slugify(p_text text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  s text;
BEGIN
  s := lower(coalesce(p_text, ''));
  s := regexp_replace(s, '[^a-z0-9]+', '-', 'g');
  s := regexp_replace(s, '^-+|-+$', '', 'g');
  s := substring(s for 40);  -- match business_partners.slug max length
  IF length(s) < 2 THEN s := 'biz-' || substring(md5(random()::text), 1, 6); END IF;
  RETURN s;
END $$;

-- Backfill slugs on existing rows that don't have one yet
UPDATE public.businesses
  SET slug = public.fn_slugify(coalesce(display_name, legal_name, 'biz'))
  WHERE slug IS NULL;

-- Resolve any duplicate slugs by appending a short hash
UPDATE public.businesses b
  SET slug = b.slug || '-' || substring(md5(b.id::text), 1, 6)
  WHERE b.id IN (
    SELECT id FROM (
      SELECT id, slug, ROW_NUMBER() OVER (PARTITION BY slug ORDER BY created_at) AS rn
        FROM public.businesses
       WHERE slug IS NOT NULL
    ) x WHERE rn > 1
  );

-- ===== 3. BEFORE INSERT trigger: auto-fill slug ===========================
CREATE OR REPLACE FUNCTION public.fn_businesses_autofill_slug()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    NEW.slug := public.fn_slugify(coalesce(NEW.display_name, NEW.legal_name, 'biz'));
    -- If the slug already exists, append a unique suffix
    IF EXISTS (SELECT 1 FROM public.businesses WHERE slug = NEW.slug AND id <> NEW.id) THEN
      NEW.slug := NEW.slug || '-' || substring(md5(NEW.id::text), 1, 6);
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_businesses_autofill_slug ON public.businesses;
CREATE TRIGGER trg_businesses_autofill_slug BEFORE INSERT ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.fn_businesses_autofill_slug();

-- ===== 4. AFTER INSERT trigger: bridge to business_partners ==============
-- When a new businesses row appears, mirror it into business_partners so
-- welcome.html?biz=<slug> works for their customers right away.
CREATE OR REPLACE FUNCTION public.fn_bridge_business_to_partner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.business_partners (
    slug,
    legal_name,
    display_name,
    contact_email,
    primary_color,
    signup_bonus_from_lymx,
    signup_bonus_from_biz,
    bonus_cents_per_lymx,
    require_admin_approval,
    active,
    owner_user_ids
  )
  VALUES (
    NEW.slug,
    COALESCE(NEW.legal_name, NEW.display_name, 'New Business'),
    COALESCE(NEW.display_name, NEW.legal_name, 'New Business'),
    NEW.contact_email,
    '#0a84ff',
    100,                                       -- LYMX welcome bonus to new customers
    50,                                        -- Business contribution (billed)
    1,                                         -- 1¢ per LYMX issued (default)
    true,                                      -- pending until business is approved by admin
    false,                                     -- not active until approved
    CASE WHEN NEW.owner_user_id IS NOT NULL
         THEN ARRAY[NEW.owner_user_id]
         ELSE NULL END
  )
  ON CONFLICT (slug) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_bridge_business_to_partner ON public.businesses;
CREATE TRIGGER trg_bridge_business_to_partner AFTER INSERT ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.fn_bridge_business_to_partner();

-- ===== 5. Approval-flip trigger: activate the bridged business_partners row =
-- When admin approves the businesses row, activate the matching business_partners
-- row (so it accepts signups + earns the business its commission split).
CREATE OR REPLACE FUNCTION public.fn_on_business_approval()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.approval_status = 'approved' AND OLD.approval_status <> 'approved' THEN
    UPDATE public.business_partners
       SET active = true,
           require_admin_approval = false,
           updated_at = now()
     WHERE slug = NEW.slug;
    NEW.approved_at := COALESCE(NEW.approved_at, now());
  END IF;
  IF NEW.approval_status = 'rejected' AND OLD.approval_status <> 'rejected' THEN
    UPDATE public.business_partners
       SET active = false,
           updated_at = now()
     WHERE slug = NEW.slug;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_on_business_approval ON public.businesses;
CREATE TRIGGER trg_on_business_approval BEFORE UPDATE OF approval_status ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.fn_on_business_approval();

-- ===== 6. RLS so admins can read the queue ================================
-- Pre-existing policies on public.businesses likely restrict to owner;
-- add an admin-read policy.
DROP POLICY IF EXISTS businesses_admin_read ON public.businesses;
CREATE POLICY businesses_admin_read ON public.businesses
  FOR SELECT TO authenticated
  USING (public.am_i_admin());

DROP POLICY IF EXISTS businesses_admin_update ON public.businesses;
CREATE POLICY businesses_admin_update ON public.businesses
  FOR UPDATE TO authenticated
  USING (public.am_i_admin())
  WITH CHECK (public.am_i_admin());

GRANT SELECT, UPDATE ON public.businesses TO authenticated;

-- ===== 7. Backfill: bridge any existing biz rows that lack a partner row ==
INSERT INTO public.business_partners (
  slug, legal_name, display_name, contact_email,
  primary_color, signup_bonus_from_lymx, signup_bonus_from_biz, bonus_cents_per_lymx,
  require_admin_approval, active, owner_user_ids
)
SELECT
  b.slug,
  COALESCE(b.legal_name, b.display_name, 'Legacy Business'),
  COALESCE(b.display_name, b.legal_name, 'Legacy Business'),
  b.contact_email,
  '#0a84ff', 100, 50, 1,
  true, false,
  CASE WHEN b.owner_user_id IS NOT NULL THEN ARRAY[b.owner_user_id] ELSE NULL END
FROM public.businesses b
WHERE b.slug IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.business_partners bp WHERE bp.slug = b.slug)
ON CONFLICT (slug) DO NOTHING;

-- ===== 8. Result ===========================================================
SELECT 'migration 035 applied' AS status,
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_schema='public' AND table_name='businesses'
           AND column_name IN ('slug','approval_status','approved_at')) AS new_columns,
       (SELECT COUNT(*) FROM public.businesses WHERE slug IS NOT NULL) AS businesses_with_slug,
       (SELECT COUNT(*) FROM public.businesses b WHERE EXISTS (SELECT 1 FROM public.business_partners bp WHERE bp.slug = b.slug)) AS bridged_count;
