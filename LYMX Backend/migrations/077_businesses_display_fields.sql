-- =============================================================================
-- Migration 077 — Display fields on businesses
-- =============================================================================
-- Added 2026-05-24 during the end-to-end business-onboarding audit ahead of
-- Susan's launch batch.
--
-- biz-dashboard.html was already reading these columns to render the page
-- header (address line under the biz name, tagline / description on the
-- live-preview card, and emoji on the photo placeholder), but the columns
-- never existed in the schema. The page silently fell back to defaults for
-- every business; admin operators had no way to set these values.
--
-- Adding them as nullable text so existing rows stay valid. Operator UI
-- (admin-businesses.html or biz-profile.html) can populate them later.
-- =============================================================================

BEGIN;

ALTER TABLE public.businesses
    ADD COLUMN IF NOT EXISTS address_line1 text,
    ADD COLUMN IF NOT EXISTS tagline       text,
    ADD COLUMN IF NOT EXISTS description   text,
    ADD COLUMN IF NOT EXISTS emoji         text;

-- Light validation: emoji is meant to be a single grapheme (one character or
-- emoji-cluster). We don't want operators pasting a sentence here. Cap length
-- at 8 chars which is enough for ZWJ-joined emoji sequences like 👨‍👩‍👧‍👦.
ALTER TABLE public.businesses
    DROP CONSTRAINT IF EXISTS businesses_emoji_short;
ALTER TABLE public.businesses
    ADD  CONSTRAINT businesses_emoji_short
    CHECK (emoji IS NULL OR char_length(emoji) <= 8);

-- Tagline is the short one-liner shown next to the business name on the
-- public welcome.html?biz=<slug> page. Keep it tight.
ALTER TABLE public.businesses
    DROP CONSTRAINT IF EXISTS businesses_tagline_short;
ALTER TABLE public.businesses
    ADD  CONSTRAINT businesses_tagline_short
    CHECK (tagline IS NULL OR char_length(tagline) <= 160);

COMMIT;
