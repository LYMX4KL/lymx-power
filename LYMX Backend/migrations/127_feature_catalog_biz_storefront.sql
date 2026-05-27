-- =============================================================================
-- Migration 127 - feature_catalog rows for the Phase 1 + Phase 2 biz-owner
-- storefront management features (per Kenny 2026-05-27: "playbook on the page")
-- =============================================================================
-- The on-page "Page guide" chip (lymx-playbook-help.js) only renders when
-- has_permission(feature_key) returns true for the current user. Without a
-- feature_catalog row for each new feature, the chip wouldn't appear even
-- after the body tag declares data-feature-key.
--
-- This migration adds 4 feature_catalog entries covering the new biz-owner
-- storefront tabs shipped 2026-05-27 (mig 124-126):
--   - business_edit_storefront   (overview, /biz-profile.html + /biz.html)
--   - business_upload_photos     (Photos tab,  /biz-profile.html)
--   - business_manage_offers     (Offers tab,  /biz-profile.html)
--   - business_manage_menu       (Menu tab,    /biz-profile.html)
--
-- default_for_roles = ['business','admin'] so every approved biz owner gets
-- the chip automatically + admins can see/edit any biz's data.
-- =============================================================================

BEGIN;

INSERT INTO public.feature_catalog (feature_key, label, description, category, default_for_roles, playbook_slug, page_paths)
VALUES
    ('business_edit_storefront',
     'Edit my LYMX storefront',
     'Overview of the biz-profile owner editor (info / hours / photos / offers / menu). Every approved business owner gets this so they can self-manage their public page at /biz?slug=<their-slug>.',
     'Business operations',
     array['business','admin'],
     'business-operations-edit-my-storefront',
     array['/biz-profile.html','/biz.html']),

    ('business_upload_photos',
     'Upload storefront photos',
     'How to upload photos to the storefront hero grid via the Photos tab on biz-profile.html. JPG/PNG/WebP, max 10 MB, up to 5 visible in the grid.',
     'Business operations',
     array['business','admin'],
     'business-operations-upload-photos',
     array['/biz-profile.html']),

    ('business_manage_offers',
     'Manage LYMX offers',
     'How to add/edit/remove offer cards (Happy Hour, Welcome bonus, etc.) that render in the Current LYMX offers section of the storefront. Max 6 offers.',
     'Business operations',
     array['business','admin'],
     'business-operations-manage-offers',
     array['/biz-profile.html']),

    ('business_manage_menu',
     'Manage menu items',
     'How to add/edit/remove menu items grouped by section (Small plates, Mains, Cocktails, etc.). Powers the Menu highlights section on the public storefront.',
     'Business operations',
     array['business','admin'],
     'business-operations-manage-menu',
     array['/biz-profile.html'])
ON CONFLICT (feature_key) DO UPDATE
    SET label             = EXCLUDED.label,
        description       = EXCLUDED.description,
        category          = EXCLUDED.category,
        default_for_roles = EXCLUDED.default_for_roles,
        playbook_slug     = EXCLUDED.playbook_slug,
        page_paths        = EXCLUDED.page_paths;

-- Sanity: confirm the 4 features landed
DO $sanity_127$
DECLARE
    v_count int;
BEGIN
    SELECT count(*) INTO v_count
      FROM public.feature_catalog
     WHERE feature_key IN ('business_edit_storefront','business_upload_photos','business_manage_offers','business_manage_menu');
    IF v_count <> 4 THEN
        RAISE EXCEPTION '127 sanity: expected 4 features, found %', v_count;
    END IF;
    RAISE NOTICE '127 sanity: 4 biz storefront feature_catalog rows in place';
END $sanity_127$;

COMMIT;
