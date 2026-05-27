-- =============================================================================
-- Migration 125 - business_photos table + storage bucket + RLS
-- =============================================================================
-- Phase 2 of T1 architectural fix (Kenny 2026-05-27).
--
-- WHAT THIS ADDS
-- --------------
-- 1. public.business_photos table (per-photo metadata: order, alt, uploader)
-- 2. business-photos Supabase Storage bucket (anon-readable so the templated
--    public storefront at biz.html?slug=X can render <img> tags without auth)
-- 3. RLS policies:
--      * SELECT: anon + authenticated (photos are public; biz.html needs them)
--      * INSERT/UPDATE/DELETE: business owner OR am_i_admin()
--    Same shape as business_documents in mig 078, but anon-readable since
--    storefront images are public-display data.
-- 4. fn_biz_photos(slug) SECURITY DEFINER RPC returning the photo list for
--    a given slug. Mirrors fn_biz_public_meta's anon-safe lookup pattern
--    so biz.html can render a photo grid without authenticated REST access.
--
-- WHY A SEPARATE RPC INSTEAD OF EXTENDING fn_biz_public_meta
-- ---------------------------------------------------------
-- fn_biz_public_meta returns a SINGLE row (one business). Photos are a
-- one-to-many child relation; returning them as a jsonb array column inside
-- the single-row meta call would force every meta lookup to denormalize
-- every photo even for callers that only need the basic fields (e.g. the
-- demo guard in lymx-biz-actions.js). A separate fn_biz_photos(slug) RPC
-- lets biz.html fetch photos lazily and keeps fn_biz_public_meta lean.
--
-- STORAGE PATH SHAPE
-- ------------------
-- <business_id>/<timestamp>_<safe-filename>.{jpg,png,webp}
-- Matches business-documents pattern (mig 078) for operational consistency.
-- =============================================================================

BEGIN;

-- 1. business_photos table
CREATE TABLE IF NOT EXISTS public.business_photos (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    file_path             text NOT NULL,                           -- bucket path
    display_order         int  NOT NULL DEFAULT 0,                 -- lower = shown first; ties broken by uploaded_at asc
    alt_text              text,                                    -- accessibility / SEO
    caption               text,                                    -- optional below-photo caption
    kind                  text NOT NULL DEFAULT 'gallery'
                          CHECK (kind IN ('hero', 'gallery', 'menu', 'interior', 'exterior', 'food', 'drink')),
    width_px              int,                                     -- captured at upload (informational)
    height_px             int,
    bytes                 int,                                     -- file size on upload
    mime_type             text,
    uploaded_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    uploaded_at           timestamptz NOT NULL DEFAULT now(),
    archived_at           timestamptz                              -- soft-delete
);

CREATE INDEX IF NOT EXISTS idx_business_photos_biz_order
    ON public.business_photos(business_id, display_order, uploaded_at)
    WHERE archived_at IS NULL;

COMMENT ON TABLE public.business_photos IS
  'One row per photo attached to a business. Files live in the business-photos storage bucket; this table tracks display order, alt text, kind, and uploader. Soft-delete via archived_at so accidental deletes can be reversed. Replaces the static emoji placeholders on biz.html with real per-business imagery.';

-- 2. Storage bucket (anon-readable, owner+admin writable)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'business-photos',
    'business-photos',
    true,                                                          -- public bucket: anon GET works without signed URL
    10 * 1024 * 1024,                                              -- 10 MB max per photo
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE
    SET public = EXCLUDED.public,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 3. RLS on business_photos
ALTER TABLE public.business_photos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS biz_photos_public_read ON public.business_photos;
CREATE POLICY biz_photos_public_read ON public.business_photos
    FOR SELECT TO anon, authenticated
    USING (archived_at IS NULL);

DROP POLICY IF EXISTS biz_photos_owner_write ON public.business_photos;
CREATE POLICY biz_photos_owner_write ON public.business_photos
    FOR ALL TO authenticated
    USING (
        public.am_i_admin()
        OR EXISTS (
            SELECT 1 FROM public.businesses b
             WHERE b.id = business_photos.business_id
               AND b.owner_user_id = auth.uid()
        )
    )
    WITH CHECK (
        public.am_i_admin()
        OR EXISTS (
            SELECT 1 FROM public.businesses b
             WHERE b.id = business_photos.business_id
               AND b.owner_user_id = auth.uid()
        )
    );

GRANT SELECT ON public.business_photos TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.business_photos TO authenticated;

-- 4. Storage bucket RLS (same anon-read, owner+admin-write pattern as business_documents)
DROP POLICY IF EXISTS biz_photos_storage_read ON storage.objects;
CREATE POLICY biz_photos_storage_read ON storage.objects
    FOR SELECT TO anon, authenticated
    USING (bucket_id = 'business-photos');

DROP POLICY IF EXISTS biz_photos_storage_write ON storage.objects;
CREATE POLICY biz_photos_storage_write ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'business-photos'
        AND (
            public.am_i_admin()
            OR EXISTS (
                SELECT 1 FROM public.businesses b
                 WHERE b.id::text = split_part(name, '/', 1)
                   AND b.owner_user_id = auth.uid()
            )
        )
    );

DROP POLICY IF EXISTS biz_photos_storage_delete ON storage.objects;
CREATE POLICY biz_photos_storage_delete ON storage.objects
    FOR DELETE TO authenticated
    USING (
        bucket_id = 'business-photos'
        AND (
            public.am_i_admin()
            OR EXISTS (
                SELECT 1 FROM public.businesses b
                 WHERE b.id::text = split_part(name, '/', 1)
                   AND b.owner_user_id = auth.uid()
            )
        )
    );

-- 5. fn_biz_photos(slug) - SECURITY DEFINER lookup mirrors fn_biz_public_meta.
--    Returns the photo list for a given biz slug, anon-safe. Filters out
--    archived photos and orders by display_order ascending then uploaded_at
--    ascending for ties.
DROP FUNCTION IF EXISTS public.fn_biz_photos(text);

CREATE OR REPLACE FUNCTION public.fn_biz_photos(p_slug text)
RETURNS TABLE (
    id            uuid,
    file_path     text,
    display_order int,
    alt_text      text,
    caption       text,
    kind          text,
    width_px      int,
    height_px     int,
    uploaded_at   timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $fn_biz_photos$
    SELECT
        p.id,
        p.file_path,
        -- public_url is built CLIENT-SIDE in biz.html as
        --   cfg.SUPABASE_URL + '/storage/v1/object/public/business-photos/' + file_path
        -- That way the URL prefix lives where the supabase config is already
        -- loaded, and the function doesn't depend on a custom app setting.
        p.display_order,
        p.alt_text,
        p.caption,
        p.kind,
        p.width_px,
        p.height_px,
        p.uploaded_at
      FROM public.business_photos p
      JOIN public.businesses b ON b.id = p.business_id
     WHERE b.slug = p_slug
       AND b.archived_at IS NULL
       AND p.archived_at IS NULL
     ORDER BY p.display_order ASC, p.uploaded_at ASC
$fn_biz_photos$;

COMMENT ON FUNCTION public.fn_biz_photos(text) IS
  'SECURITY DEFINER lookup of public business photos by slug. Returns id, file_path, display_order, alt_text, caption, kind, dimensions, uploaded_at. Filters out archived photos. Anon + authenticated callers welcome. Backs the photo grid render on biz.html. Caller constructs the public URL from file_path + their Supabase base URL (no signed URL needed since the bucket is public).';

GRANT EXECUTE ON FUNCTION public.fn_biz_photos(text) TO anon, authenticated, service_role;

-- 6. Sanity output: confirm bucket exists + 2 demo slugs have 0 photos (yet)
DO $sanity_125$
DECLARE
    v_bucket_exists boolean;
    v_oak_count int;
    v_brew_count int;
BEGIN
    SELECT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'business-photos') INTO v_bucket_exists;
    SELECT count(*) INTO v_oak_count  FROM public.fn_biz_photos('oakline-kitchen');
    SELECT count(*) INTO v_brew_count FROM public.fn_biz_photos('brew-and-bean');
    RAISE NOTICE '125 sanity: bucket_exists=% oakline_photos=% brew_photos=%',
        v_bucket_exists, v_oak_count, v_brew_count;
END $sanity_125$;

COMMIT;
