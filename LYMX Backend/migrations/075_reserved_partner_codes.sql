-- =============================================================================
-- LYMX Power — Migration 075: Reserved partner codes for high-producer rewards
-- =============================================================================
-- 2026-05-23
--
-- Kenny's directive (2026-05-23):
--   "save partner IDs with repeat numbers (11, 22, 33, ..., 111, 222, 333, ...)
--    to reward high-producing partners."
--
-- Partner codes are P-NNNNNN format (migration 024). The auto-generated
-- sequence (public.partner_code_seq) hands out P-000100, P-000101, P-000102, …
-- in order. Without intervention, a high-producing partner who joins after
-- 100 random Helens have already signed up gets a forgettable code like
-- P-000847.
--
-- This migration:
--   1. Creates `reserved_partner_codes` table — every "premium" code (the
--      repeat-digit numbers) is pre-listed here.
--   2. Modifies `generate_partner_code()` trigger to SKIP any code in the
--      reserved set when handing out the next sequence value.
--   3. Adds `claim_reserved_partner_code(uuid, text)` admin RPC so Kenny /
--      Helen can manually assign a reserved code to a specific partner as
--      a reward, swapping their old auto-assigned code.
--   4. Pre-populates the reserved list with 11/22/33/.../99,
--      111/222/.../999, 1111/.../9999, 11111/.../99999, 111111/.../999999.
--      ~54 codes total.
--
-- Idempotent — re-running is safe.
-- =============================================================================

-- ---------- 1. Table ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.reserved_partner_codes (
    code                 TEXT PRIMARY KEY,            -- e.g. 'P-000111'
    digit_repeat         INT NOT NULL,                -- 2,3,4,5,6 (length of repeat run)
    repeated_digit       INT NOT NULL,                -- 1..9
    tier                 TEXT NOT NULL DEFAULT 'standard',  -- 'platinum'|'gold'|'silver'|'standard' (Kenny can rank later)
    notes                TEXT,
    assigned_to_partner_id UUID REFERENCES public.partners(id) ON DELETE SET NULL,
    assigned_at          TIMESTAMPTZ,
    assigned_by          UUID,                        -- admin user_id who claimed it
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reserved_partner_codes_unassigned
    ON public.reserved_partner_codes (digit_repeat, repeated_digit)
    WHERE assigned_to_partner_id IS NULL;

ALTER TABLE public.reserved_partner_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reserved_partner_codes_read_all_auth ON public.reserved_partner_codes;
CREATE POLICY reserved_partner_codes_read_all_auth ON public.reserved_partner_codes
    FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS reserved_partner_codes_admin_write ON public.reserved_partner_codes;
CREATE POLICY reserved_partner_codes_admin_write ON public.reserved_partner_codes
    FOR ALL TO authenticated
    USING (public.am_i_admin())
    WITH CHECK (public.am_i_admin());


-- ---------- 2. Pre-populate the reserved list --------------------------------

DO $populate$
DECLARE
    d INT;
    digit INT;
    code_str TEXT;
    tier_val TEXT;
BEGIN
    -- d = how many repeats (2..6). digit = which digit (1..9).
    -- For example d=3, digit=7 → 777 → P-000777
    -- For d=6, digit=1 → 111111 → P-111111
    FOR d IN 2..6 LOOP
        FOR digit IN 1..9 LOOP
            -- repeat the digit d times, then format as P-NNNNNN
            code_str := 'P-' || lpad(repeat(digit::text, d), 6, '0');
            -- Tier heuristic: more repeats = higher tier. d=6 platinum, d=5 gold, d=4 silver, else standard
            tier_val := CASE
                WHEN d = 6 THEN 'platinum'
                WHEN d = 5 THEN 'gold'
                WHEN d = 4 THEN 'silver'
                ELSE 'standard'
            END;
            INSERT INTO public.reserved_partner_codes (code, digit_repeat, repeated_digit, tier, notes)
            VALUES (code_str, d, digit, tier_val,
                    'Pre-reserved 2026-05-23 for high-producer reward (' || d::text || '× digit ' || digit::text || ')')
            ON CONFLICT (code) DO NOTHING;
        END LOOP;
    END LOOP;
END
$populate$;


-- ---------- 3. Mark any already-assigned codes as taken ----------------------
-- Some founding 25 ranks (1..25) collide with reserved 11 + 22 codes.
-- E.g. founding_25_rank=11 → P-000011, which is now reserved as well.
-- Treat those partners as having already claimed their reserved code.

UPDATE public.reserved_partner_codes rpc
   SET assigned_to_partner_id = p.id,
       assigned_at            = COALESCE(rpc.assigned_at, p.created_at, NOW()),
       notes                  = COALESCE(rpc.notes, '') || ' [auto-linked to existing partner ' || COALESCE(p.legal_name, p.id::text) || ' during migration 075 backfill]'
  FROM public.partners p
 WHERE p.partner_code = rpc.code
   AND rpc.assigned_to_partner_id IS NULL;


-- ---------- 4. Modify generate_partner_code() trigger to SKIP reserved -------

CREATE OR REPLACE FUNCTION public.generate_partner_code()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $body$
DECLARE
    v_seq        BIGINT;
    v_candidate  TEXT;
    v_attempts   INT := 0;
    v_is_reserved BOOLEAN;
BEGIN
    -- If a code is already set, keep it (idempotent for backfills, manual codes)
    IF NEW.partner_code IS NOT NULL AND NEW.partner_code <> '' THEN
        RETURN NEW;
    END IF;

    -- Founding 25 get deterministic codes from their rank.
    -- IMPORTANT: founding 25 rank may coincide with a reserved code (e.g. rank
    -- 11 → P-000011). That's fine — the migration 075 backfill marks the
    -- reserved row as assigned_to_partner_id so the reservation is "consumed"
    -- by the founding partner. We don't skip on the founding path.
    IF NEW.is_founding_25 = TRUE AND NEW.founding_25_rank BETWEEN 1 AND 25 THEN
        NEW.partner_code := 'P-' || lpad(NEW.founding_25_rank::text, 6, '0');
        -- If by coincidence this matches a reserved code, mark it assigned
        UPDATE public.reserved_partner_codes
           SET assigned_to_partner_id = NEW.id,
               assigned_at            = COALESCE(assigned_at, NOW())
         WHERE code = NEW.partner_code
           AND assigned_to_partner_id IS NULL;
        RETURN NEW;
    END IF;

    -- For everyone else: pull next sequence value, but SKIP if it's in the
    -- reserved set. Cap attempts to prevent infinite loop in pathological
    -- cases (e.g. someone manually filled reserved codes with junk).
    LOOP
        v_attempts := v_attempts + 1;
        IF v_attempts > 200 THEN
            RAISE EXCEPTION 'generate_partner_code: gave up after 200 attempts trying to skip reserved codes';
        END IF;
        v_seq := nextval('public.partner_code_seq');
        v_candidate := 'P-' || lpad(v_seq::text, 6, '0');
        SELECT TRUE INTO v_is_reserved
          FROM public.reserved_partner_codes
         WHERE code = v_candidate
           AND assigned_to_partner_id IS NULL
         LIMIT 1;
        IF v_is_reserved IS NULL THEN
            -- Either not in reserved set, or already assigned (= consumed) — use it.
            EXIT;
        END IF;
        -- else: keep looping, try next sequence value
        v_is_reserved := NULL;
    END LOOP;

    NEW.partner_code := v_candidate;
    RETURN NEW;
END
$body$;


-- ---------- 5. Admin RPC: claim a reserved code for a specific partner -------

CREATE OR REPLACE FUNCTION public.claim_reserved_partner_code(
    p_partner_id UUID,
    p_code       TEXT
)
RETURNS TABLE (success BOOLEAN, old_code TEXT, new_code TEXT, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $body$
DECLARE
    v_old_code     TEXT;
    v_normalized   TEXT;
    v_reserved_row public.reserved_partner_codes%ROWTYPE;
    v_admin_id     UUID := auth.uid();
BEGIN
    -- Permission check: admin only
    IF NOT public.am_i_admin() THEN
        RETURN QUERY SELECT FALSE, NULL::TEXT, NULL::TEXT, 'permission denied: admin role required';
        RETURN;
    END IF;

    v_normalized := upper(trim(p_code));
    IF v_normalized NOT LIKE 'P-______' THEN
        RETURN QUERY SELECT FALSE, NULL::TEXT, NULL::TEXT, 'code must be in P-NNNNNN format';
        RETURN;
    END IF;

    SELECT * INTO v_reserved_row FROM public.reserved_partner_codes WHERE code = v_normalized;
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, NULL::TEXT, NULL::TEXT, 'code ' || v_normalized || ' is not in the reserved list';
        RETURN;
    END IF;
    IF v_reserved_row.assigned_to_partner_id IS NOT NULL
       AND v_reserved_row.assigned_to_partner_id <> p_partner_id THEN
        RETURN QUERY SELECT FALSE, NULL::TEXT, NULL::TEXT,
                     'code ' || v_normalized || ' already assigned to partner ' || v_reserved_row.assigned_to_partner_id::text;
        RETURN;
    END IF;

    SELECT partner_code INTO v_old_code FROM public.partners WHERE id = p_partner_id;
    IF v_old_code IS NULL THEN
        RETURN QUERY SELECT FALSE, NULL::TEXT, NULL::TEXT, 'partner ' || p_partner_id::text || ' not found';
        RETURN;
    END IF;

    -- Swap: partner gets the reserved code; reserved row marked assigned.
    UPDATE public.partners SET partner_code = v_normalized WHERE id = p_partner_id;
    UPDATE public.reserved_partner_codes
       SET assigned_to_partner_id = p_partner_id,
           assigned_at            = NOW(),
           assigned_by            = v_admin_id,
           notes                  = COALESCE(notes, '') || ' [claimed ' || NOW()::text || ' by admin ' || COALESCE(v_admin_id::text, '?') || ' replacing old code ' || COALESCE(v_old_code, '?') || ']'
     WHERE code = v_normalized;

    RETURN QUERY SELECT TRUE, v_old_code, v_normalized,
                 'reassigned partner ' || p_partner_id::text || ' from ' || COALESCE(v_old_code,'?') || ' to ' || v_normalized;
END
$body$;

REVOKE ALL ON FUNCTION public.claim_reserved_partner_code(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_reserved_partner_code(UUID, TEXT) TO authenticated;


-- ---------- 6. Sanity report -------------------------------------------------

DO $sanity$
DECLARE
    v_total      INT;
    v_assigned   INT;
    v_unassigned INT;
    v_platinum   INT;
    v_gold       INT;
    v_silver     INT;
BEGIN
    SELECT COUNT(*) INTO v_total      FROM public.reserved_partner_codes;
    SELECT COUNT(*) INTO v_assigned   FROM public.reserved_partner_codes WHERE assigned_to_partner_id IS NOT NULL;
    SELECT COUNT(*) INTO v_unassigned FROM public.reserved_partner_codes WHERE assigned_to_partner_id IS NULL;
    SELECT COUNT(*) INTO v_platinum   FROM public.reserved_partner_codes WHERE tier='platinum';
    SELECT COUNT(*) INTO v_gold       FROM public.reserved_partner_codes WHERE tier='gold';
    SELECT COUNT(*) INTO v_silver     FROM public.reserved_partner_codes WHERE tier='silver';
    RAISE NOTICE 'migration 075 applied | reserved=% (assigned=% unassigned=%) | platinum=% gold=% silver=%',
        v_total, v_assigned, v_unassigned, v_platinum, v_gold, v_silver;
END
$sanity$;
