-- =============================================================================
-- Re-tag backend-blocked tickets — Phase 0 of biz-onboarding roadmap (2026-05-26)
-- =============================================================================
-- Per audits/BIZ-ONBOARDING-GAPS-2026-05-26.md § Phase 5, these 13 open
-- feedback tickets are NOT real frontend bugs — they're "frontend promises a
-- feature that has no backend" pages. Previous sessions repeatedly band-aided
-- them into "fixed, please verify" replies that broke the tester's trust loop.
--
-- This script:
--   1. Updates each ticket's status + admin_notes so future triage knows
--      these are blocked on planned backend modules, not in-flight bugs.
--   2. Inserts a single admin_response reply per ticket explaining the
--      situation (no verification button — testers should NOT re-verify
--      these until the backend module ships).
--   3. Leaves the door open: when a future module ships, that ticket's
--      verification reply will come automatically as part of its commit.
--
-- One ticket — 9501d43e (Table Reservation "Business Not Found") — IS resolved
-- by migration 092 because the demo businesses now have real rows. That one
-- gets `asks_verification=true` so the tester can confirm the banner + the
-- "preview" refusal message is sensible.
--
-- Run in Supabase SQL editor. Kenny's auth.uid() is used as the reply author.
-- =============================================================================

BEGIN;

-- ─── 1. Author identity (Kenny @ getlymx / lymxpower) ─────────────────────
DO $author$
DECLARE
    v_kenny uuid;
    v_email text;
    v_name  text := 'Kenny';
BEGIN
    -- Resolve Kenny's auth user id from his canonical inbox.
    SELECT id, email INTO v_kenny, v_email
      FROM auth.users
     WHERE email = 'kenny@lymxpower.com'
        OR email = 'zhongkennylin@gmail.com'
     ORDER BY (email = 'kenny@lymxpower.com') DESC, created_at ASC
     LIMIT 1;

    IF v_kenny IS NULL THEN
        RAISE EXCEPTION 'Could not resolve Kenny''s auth user — aborting.';
    END IF;

    -- Stash for use across the script via a temp table (no GUC churn).
    CREATE TEMP TABLE _retag_ctx (
        kenny_id uuid,
        kenny_email text,
        kenny_name text
    ) ON COMMIT DROP;
    INSERT INTO _retag_ctx VALUES (v_kenny, v_email, v_name);
END $author$;

-- ─── 2. Re-tag mapping: prefix → (subject hint, module note, reply body) ──
-- Stored as a VALUES list. id_prefix is the 8-char hex prefix shown in the
-- audit doc; we LIKE-match against id::text so the script is robust against
-- whatever the full UUID is. asks_verify=true ONLY for the 1 ticket actually
-- resolved by this commit.
WITH retag(id_prefix, subject_hint, future_module, reply_body, asks_verify) AS (
    VALUES
        ('ecb89464', 'Donate LYMX',
         'Future: charity module',
         'Thanks for flagging this. "Donate LYMX" is a planned feature for a future charity module — the page is in the UI but the backend (donation ledger, partner-charity routing) hasn''t been built yet. No need to verify; we''ll ping you when the donation backend ships. — Kenny',
         false),
        ('42d71317', 'Payout Method',
         'Module 5 (wallet/payouts)',
         'Thanks. Payout method add-card flow is blocked on Module 5 of the onboarding roadmap (wallet + transactions pipeline unification + Stripe Connect customer-side). Backend audit found two parallel issuance pipelines that need merging first. No need to verify — we''ll ping when wallets are wired. — Kenny',
         false),
        ('7bfc73c8', 'Comp Plan 404',
         'Future: partner training module',
         'Thanks. The Comp Plan content page is planned for the Partner training module (not yet scheduled). No backend dependency, just content not written. We''ll ping you when the page lands. — Kenny',
         false),
        ('5bc1c9ed', 'Create Free Wallet Now',
         'Module 5 (wallet pipeline)',
         'Thanks. Wallet creation is blocked on Module 5 of the onboarding roadmap — the 2026-05-26 audit found the wallets table is empty despite issuances existing (two parallel pipelines that don''t sync). Fixing this is the biggest single module on the roadmap. No need to verify; we''ll ping when wallets work end-to-end. — Kenny',
         false),
        ('d959601d', 'Partner Notifications',
         'Future: notifications module',
         'Thanks. Partner notifications backend (delivery rules, channel preferences, in-app feed) hasn''t been built yet. The page promises something the system can''t yet do. No need to verify — we''ll ping when the notifications module lands. — Kenny',
         false),
        ('804f57da', 'Partner My LYMX Wallet',
         'Module 5 (wallet pipeline)',
         'Thanks. Partner wallet view depends on Module 5 (wallet+transactions pipeline). Same root cause as the customer wallet — empty tables, dual pipelines. No need to verify; pinging when wallets are unified. — Kenny',
         false),
        ('7d044c5e', 'Partner My Reviews',
         'Future: partner module surfaces',
         'Thanks. There''s no "partner reviews" surface in the backend yet — partners aren''t a reviewable entity in our model (only businesses are). This needs a product decision before we build. No need to verify; we''ll loop you in when we scope this. — Kenny',
         false),
        ('b37214f3', 'Recruited Customer Referrals view',
         'Module 1 (invitations)',
         'Thanks. The "recruited customer referrals" view comes online with Module 1 of the onboarding roadmap (the invitation system — biz_invitations table + audit trail of who clicked which partner''s link). Coming in the next session or two. No need to verify in the meantime. — Kenny',
         false),
        ('4aa8c795', 'Clock in Button missing',
         'Future: clock-in audit',
         'Thanks. Clock-in has been band-aided multiple times and needs a proper audit pass (not another patch). Adding it to the audit queue alongside the wallet pipeline. No need to verify the current behavior; we''ll ping when the audit + real fix lands. — Kenny',
         false),
        ('82ac08f5', 'Browse See All',
         'Future: browse module',
         'Thanks. The "See All" browse page hasn''t been built yet. The card was added with the intent but the underlying listings/filter backend isn''t there. No need to verify; we''ll ping when the browse module lands. — Kenny',
         false),
        ('98fcfa23', 'Pending Review — no link',
         'Future: customer reviews module',
         'Thanks. The "pending review" surface for customers needs a backend view that joins reviews with their verification state. Not yet built. No need to verify; we''ll ping when the customer-side review surface ships. — Kenny',
         false),
        ('9501d43e', 'Table Reservation Business Not Found',
         'Phase 0 (this commit)',
         'Fixed today. Migration 092 added real rows for the static demo pages (Brew & Bean, Oakline Kitchen) so the slug lookup succeeds. Because these are sample/preview businesses (not real merchants), a PREVIEW banner now appears at the top of those pages and the Reserve / Save / Review actions show a clear "preview only" message instead of writing real reservations. Please reload the page and confirm you see the banner + the preview message when you tap Reserve. — Kenny',
         true),
        ('026db35c', 'Reserve Table doesn''t persist',
         'Future: reservations module (plus Phase 0 demo guard)',
         'Partial: the static preview pages now refuse to write reservations (PREVIEW banner + "preview only" message — that''s the Phase 0 demo guard from today). For REAL approved businesses, table_reservations writes are wired through lymx-biz-actions.js (shipped 2026-05-25). The full reservation lifecycle (confirm/decline by biz, customer email confirmation, calendar block) is a future reservations module. No need to re-test the demo-page case; we''ll ping when the real-biz lifecycle lands. — Kenny',
         false)
)
-- ─── 3. UPDATE the feedback rows (admin_notes + status hold at in_progress)
, updated AS (
    UPDATE public.feedback f
       SET admin_notes = 'BLOCKED ON BACKEND BUILD: ' || r.future_module
                       || ' (re-tagged 2026-05-26 per biz-onboarding audit Phase 5)',
           status      = CASE WHEN r.asks_verify THEN 'resolved' ELSE 'in_progress' END,
           updated_at  = now()
      FROM retag r
     WHERE f.id::text LIKE r.id_prefix || '%'
       AND f.status NOT IN ('resolved','wontfix')  -- don't reopen anything Kenny already closed
    RETURNING f.id, r.id_prefix, r.subject_hint, r.reply_body, r.asks_verify
)
-- ─── 4. INSERT one admin_response reply per re-tagged ticket ───────────────
INSERT INTO public.feedback_replies
    (feedback_id, author_id, author_name, author_email, author_role,
     kind, body_text, asks_verification)
SELECT u.id,
       c.kenny_id,
       c.kenny_name,
       c.kenny_email,
       'broker',
       'admin_response',
       u.reply_body,
       u.asks_verify
  FROM updated u
 CROSS JOIN _retag_ctx c;

-- ─── 5. Sanity output ─────────────────────────────────────────────────────
DO $sanity$
DECLARE
    v_updated_count integer;
    v_replied_count integer;
    v_missing       text;
BEGIN
    SELECT count(*) INTO v_updated_count
      FROM public.feedback
     WHERE admin_notes LIKE 'BLOCKED ON BACKEND BUILD%'
       AND updated_at >= (now() - interval '5 minutes');

    SELECT count(*) INTO v_replied_count
      FROM public.feedback_replies
     WHERE body_text LIKE '%onboarding roadmap%' OR body_text LIKE '%no need to verify%'
        OR body_text LIKE '%PREVIEW banner%';

    -- Identify any prefix that didn't match a feedback row (would suggest the
    -- ticket was closed/deleted or the prefix has drifted)
    WITH expected(p) AS (VALUES
        ('ecb89464'),('42d71317'),('7bfc73c8'),('5bc1c9ed'),('d959601d'),
        ('804f57da'),('7d044c5e'),('b37214f3'),('4aa8c795'),('82ac08f5'),
        ('98fcfa23'),('9501d43e'),('026db35c'))
    SELECT string_agg(p, ', ') INTO v_missing
      FROM expected e
     WHERE NOT EXISTS (
        SELECT 1 FROM public.feedback f
         WHERE f.id::text LIKE e.p || '%'
           AND f.admin_notes LIKE 'BLOCKED ON BACKEND BUILD%'
     );

    RAISE NOTICE 'Re-tagged % tickets, posted % replies.', v_updated_count, v_replied_count;
    IF v_missing IS NOT NULL AND length(v_missing) > 0 THEN
        RAISE WARNING 'Prefixes that did NOT match an open ticket (already closed or drifted): %', v_missing;
    END IF;
END $sanity$;

COMMIT;

-- =============================================================================
-- Post-run verification (run separately to inspect)
-- =============================================================================
-- SELECT id, type, subject, status, admin_notes, updated_at
--   FROM public.feedback
--  WHERE admin_notes LIKE 'BLOCKED ON BACKEND BUILD%'
--  ORDER BY updated_at DESC;
--
-- SELECT f.id, f.subject, r.created_at, r.asks_verification, left(r.body_text, 80) AS body_preview
--   FROM public.feedback f
--   JOIN public.feedback_replies r ON r.feedback_id = f.id
--  WHERE f.admin_notes LIKE 'BLOCKED ON BACKEND BUILD%'
--    AND r.created_at >= (now() - interval '1 hour')
--  ORDER BY r.created_at DESC;
-- =============================================================================
