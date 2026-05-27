-- =============================================================================
-- Migration 126 - business_menu_items table + RLS + fn_biz_menu RPC
-- =============================================================================
-- Phase 2 strand 3 of T1 architectural fix (Kenny 2026-05-27).
--
-- WHAT THIS ADDS
-- --------------
-- 1. public.business_menu_items table (per-item data: section, name, price)
-- 2. RLS: anon SELECT (menus are public storefront data),
--         owner+admin INSERT/UPDATE/DELETE (same shape as business_photos)
-- 3. fn_biz_menu(slug) SECURITY DEFINER RPC that returns menu items for a
--    business slug, grouped by section (returned in section + display_order).
--    biz.html iterates the result to render the Menu highlights section.
--
-- WHY A SEPARATE TABLE + RPC (vs jsonb on businesses)
-- ---------------------------------------------------
-- current_promos is a jsonb on businesses because it's typically <=6 small
-- objects. Menu items can have hundreds of rows per business and benefit
-- from a proper relational table (per-item edits, indexes, soft-delete,
-- per-item availability toggles, future per-item photos). Same reasoning
-- as business_photos vs an emoji column.
--
-- SECTION STRING (free-form, not enum)
-- ------------------------------------
-- We let the biz owner type any section label ("Small plates", "Mains",
-- "Cocktails", "Bottomless brunch") because cuisines vary widely. The UI
-- can autocomplete from the biz's existing distinct section values.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.business_menu_items (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    section         text NOT NULL DEFAULT 'Menu',                  -- "Small plates", "Mains", etc. (free-form by design)
    name            text NOT NULL,                                  -- "Hand-pulled beef noodle"
    description     text,                                           -- "5-hour broth, daikon, bok choy, chili oil"
    price_cents     int,                                            -- 2200 = $22.00. NULL means "Market price" / no price shown
    display_order   int  NOT NULL DEFAULT 0,                        -- lower = shown first within section
    available       boolean NOT NULL DEFAULT true,                  -- hide without deleting (sold out, seasonal)
    dietary_tags    text[],                                         -- ["vegetarian", "gluten-free", "spicy"] - free-form
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    archived_at     timestamptz,                                    -- soft-delete
    created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_business_menu_items_biz_section_order
    ON public.business_menu_items(business_id, section, display_order, name)
    WHERE archived_at IS NULL;

-- Auto-update updated_at on UPDATE
CREATE OR REPLACE FUNCTION public.fn_business_menu_items_touch_updated()
RETURNS trigger
LANGUAGE plpgsql
AS $touch$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $touch$;

DROP TRIGGER IF EXISTS tg_business_menu_items_touch ON public.business_menu_items;
CREATE TRIGGER tg_business_menu_items_touch
    BEFORE UPDATE ON public.business_menu_items
    FOR EACH ROW EXECUTE FUNCTION public.fn_business_menu_items_touch_updated();

COMMENT ON TABLE public.business_menu_items IS
  'One row per menu item attached to a business. Grouped by section (free-form), ordered by display_order within section. Soft-delete via archived_at. Renders in the Menu highlights section of biz.html. Owner-editable via biz-profile.html Menu tab; admin-editable via am_i_admin().';

-- RLS: anon read, owner+admin write
ALTER TABLE public.business_menu_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS biz_menu_public_read ON public.business_menu_items;
CREATE POLICY biz_menu_public_read ON public.business_menu_items
    FOR SELECT TO anon, authenticated
    USING (archived_at IS NULL AND available = true);

-- Owner can see all (including hidden + archived); admin too
DROP POLICY IF EXISTS biz_menu_owner_read_all ON public.business_menu_items;
CREATE POLICY biz_menu_owner_read_all ON public.business_menu_items
    FOR SELECT TO authenticated
    USING (
        public.am_i_admin()
        OR EXISTS (
            SELECT 1 FROM public.businesses b
             WHERE b.id = business_menu_items.business_id
               AND b.owner_user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS biz_menu_owner_write ON public.business_menu_items;
CREATE POLICY biz_menu_owner_write ON public.business_menu_items
    FOR ALL TO authenticated
    USING (
        public.am_i_admin()
        OR EXISTS (
            SELECT 1 FROM public.businesses b
             WHERE b.id = business_menu_items.business_id
               AND b.owner_user_id = auth.uid()
        )
    )
    WITH CHECK (
        public.am_i_admin()
        OR EXISTS (
            SELECT 1 FROM public.businesses b
             WHERE b.id = business_menu_items.business_id
               AND b.owner_user_id = auth.uid()
        )
    );

GRANT SELECT ON public.business_menu_items TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.business_menu_items TO authenticated;

-- fn_biz_menu(slug): SECURITY DEFINER, returns available items ordered by
-- section + display_order so biz.html can render with a single fetch.
DROP FUNCTION IF EXISTS public.fn_biz_menu(text);

CREATE OR REPLACE FUNCTION public.fn_biz_menu(p_slug text)
RETURNS TABLE (
    id            uuid,
    section       text,
    name          text,
    description   text,
    price_cents   int,
    display_order int,
    dietary_tags  text[]
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $fn_biz_menu$
    SELECT
        m.id, m.section, m.name, m.description, m.price_cents, m.display_order, m.dietary_tags
      FROM public.business_menu_items m
      JOIN public.businesses b ON b.id = m.business_id
     WHERE b.slug = p_slug
       AND b.archived_at IS NULL
       AND m.archived_at IS NULL
       AND m.available = true
     ORDER BY m.section ASC, m.display_order ASC, m.name ASC
$fn_biz_menu$;

COMMENT ON FUNCTION public.fn_biz_menu(text) IS
  'SECURITY DEFINER lookup of public menu items by business slug. Returns id, section, name, description, price_cents, display_order, dietary_tags. Filters to available + non-archived. Ordered by section then display_order then name. Backs the Menu highlights render on biz.html.';

GRANT EXECUTE ON FUNCTION public.fn_biz_menu(text) TO anon, authenticated, service_role;

-- Sanity: bucket-style verification but for the new RPC
DO $sanity_126$
DECLARE
    v_oak_count int;
BEGIN
    SELECT count(*) INTO v_oak_count FROM public.fn_biz_menu('oakline-kitchen');
    RAISE NOTICE '126 sanity: oakline_menu_items=% (expected 0; menu items must be added via owner UI)',
        v_oak_count;
END $sanity_126$;

COMMIT;
