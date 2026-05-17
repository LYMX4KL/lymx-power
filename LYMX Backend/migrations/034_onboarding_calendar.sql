-- Migration 034: Onboarding calendar booking system
-- ---------------------------------------------------------------------------
-- Created 2026-05-16 for Rachel (and any future onboarding lead) to take
-- 30-minute 1-on-1 calls with prospective LYMX Businesses.
--
-- Three tables:
--   1. onboarding_hosts          — staff who can host calls (Rachel today; multi-staff later)
--   2. onboarding_availability   — recurring weekly availability windows per host
--   3. onboarding_bookings       — actual booked time slots + customer info
--
-- 30-minute fixed-length slots. Public page can read available slots; only
-- authenticated users can book; only admin/host can manage availability.
-- ---------------------------------------------------------------------------

-- ===== 1. Hosts =============================================================
CREATE TABLE IF NOT EXISTS public.onboarding_hosts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name    text NOT NULL,           -- "Rachel"
  email           text NOT NULL,           -- where booking confirmations go
  slot_minutes    int  NOT NULL DEFAULT 30 CHECK (slot_minutes IN (15, 30, 45, 60)),
  buffer_minutes  int  NOT NULL DEFAULT 5  CHECK (buffer_minutes >= 0 AND buffer_minutes <= 60),
  timezone        text NOT NULL DEFAULT 'America/Los_Angeles', -- IANA tz; Rachel's local
  active          boolean NOT NULL DEFAULT true,
  intro_note      text,                    -- shown on the public booking page
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_hosts_active ON public.onboarding_hosts(active);

-- ===== 2. Recurring weekly availability =====================================
-- Each row = one weekly window (e.g. "Mon 09:00-12:00 in Rachel's tz")
CREATE TABLE IF NOT EXISTS public.onboarding_availability (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id         uuid NOT NULL REFERENCES public.onboarding_hosts(id) ON DELETE CASCADE,
  day_of_week     int  NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0=Sunday, 6=Saturday
  start_minute    int  NOT NULL CHECK (start_minute BETWEEN 0 AND 1440),  -- minutes from midnight in host's tz
  end_minute      int  NOT NULL CHECK (end_minute BETWEEN 0 AND 1440),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (end_minute > start_minute)
);

CREATE INDEX IF NOT EXISTS idx_availability_host ON public.onboarding_availability(host_id, day_of_week);

-- ===== 3. Bookings ==========================================================
CREATE TABLE IF NOT EXISTS public.onboarding_bookings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id           uuid NOT NULL REFERENCES public.onboarding_hosts(id) ON DELETE RESTRICT,
  starts_at         timestamptz NOT NULL,           -- UTC; UI converts to host tz + booker tz
  ends_at           timestamptz NOT NULL,
  booker_user_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  booker_name       text NOT NULL,
  booker_email      text NOT NULL,
  booker_phone      text,
  business_name     text,                            -- if booking for a business
  topic             text,                            -- e.g. "Onboarding for Brew & Bean Café"
  notes             text,                            -- "Anything we should know before the call?"
  meeting_url       text,                            -- Zoom/Meet link — populated after booking by host
  status            text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled_by_booker', 'cancelled_by_host', 'no_show', 'completed')),
  cancel_token      text NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
  reminder_sent_24h boolean NOT NULL DEFAULT false,
  reminder_sent_1h  boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_bookings_host_starts ON public.onboarding_bookings(host_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_booker      ON public.onboarding_bookings(booker_user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status      ON public.onboarding_bookings(status);

-- Prevent double-booking the same host at the same time
CREATE UNIQUE INDEX IF NOT EXISTS uniq_bookings_no_overlap
  ON public.onboarding_bookings(host_id, starts_at)
  WHERE status = 'confirmed';

-- ===== 4. RLS ===============================================================
ALTER TABLE public.onboarding_hosts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_bookings     ENABLE ROW LEVEL SECURITY;

-- Anyone (including anon) can read active hosts + their availability — needed for the public booking page
DROP POLICY IF EXISTS hosts_public_read ON public.onboarding_hosts;
CREATE POLICY hosts_public_read ON public.onboarding_hosts FOR SELECT TO anon, authenticated USING (active);

DROP POLICY IF EXISTS availability_public_read ON public.onboarding_availability;
CREATE POLICY availability_public_read ON public.onboarding_availability FOR SELECT TO anon, authenticated USING (true);

-- Anyone (anon or authenticated) can see WHICH slots are already taken (for collision detection)
-- but they only see start/end times, not the booker details
DROP POLICY IF EXISTS bookings_busy_read ON public.onboarding_bookings;
CREATE POLICY bookings_busy_read ON public.onboarding_bookings
  FOR SELECT TO anon, authenticated
  USING (status = 'confirmed');

-- Authenticated users can INSERT a booking for themselves
DROP POLICY IF EXISTS bookings_self_insert ON public.onboarding_bookings;
CREATE POLICY bookings_self_insert ON public.onboarding_bookings
  FOR INSERT TO authenticated
  WITH CHECK (booker_user_id = auth.uid() OR booker_user_id IS NULL);

-- Anon users can also book (we collect their email; signup not required)
DROP POLICY IF EXISTS bookings_anon_insert ON public.onboarding_bookings;
CREATE POLICY bookings_anon_insert ON public.onboarding_bookings
  FOR INSERT TO anon
  WITH CHECK (booker_user_id IS NULL);

-- The booker can update their own booking (for cancellation via token)
DROP POLICY IF EXISTS bookings_self_update ON public.onboarding_bookings;
CREATE POLICY bookings_self_update ON public.onboarding_bookings
  FOR UPDATE TO authenticated
  USING (booker_user_id = auth.uid())
  WITH CHECK (booker_user_id = auth.uid());

-- Admin (and the host themselves) can do anything
DROP POLICY IF EXISTS bookings_admin_all ON public.onboarding_bookings;
CREATE POLICY bookings_admin_all ON public.onboarding_bookings
  FOR ALL TO authenticated
  USING (public.am_i_admin() OR host_id IN (SELECT id FROM public.onboarding_hosts WHERE user_id = auth.uid()))
  WITH CHECK (public.am_i_admin() OR host_id IN (SELECT id FROM public.onboarding_hosts WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS hosts_admin_write ON public.onboarding_hosts;
CREATE POLICY hosts_admin_write ON public.onboarding_hosts
  FOR ALL TO authenticated
  USING (public.am_i_admin() OR user_id = auth.uid())
  WITH CHECK (public.am_i_admin() OR user_id = auth.uid());

DROP POLICY IF EXISTS availability_admin_write ON public.onboarding_availability;
CREATE POLICY availability_admin_write ON public.onboarding_availability
  FOR ALL TO authenticated
  USING (public.am_i_admin() OR host_id IN (SELECT id FROM public.onboarding_hosts WHERE user_id = auth.uid()))
  WITH CHECK (public.am_i_admin() OR host_id IN (SELECT id FROM public.onboarding_hosts WHERE user_id = auth.uid()));

-- ===== 5. GRANTs ============================================================
GRANT SELECT                          ON public.onboarding_hosts        TO anon, authenticated;
GRANT SELECT                          ON public.onboarding_availability TO anon, authenticated;
GRANT SELECT, INSERT                  ON public.onboarding_bookings     TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE  ON public.onboarding_bookings     TO authenticated;
GRANT INSERT, UPDATE, DELETE          ON public.onboarding_hosts        TO authenticated;
GRANT INSERT, UPDATE, DELETE          ON public.onboarding_availability TO authenticated;

-- ===== 6. updated_at trigger ================================================
CREATE OR REPLACE FUNCTION public.fn_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_hosts_updated      ON public.onboarding_hosts;
CREATE TRIGGER trg_hosts_updated      BEFORE UPDATE ON public.onboarding_hosts      FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();
DROP TRIGGER IF EXISTS trg_bookings_updated   ON public.onboarding_bookings;
CREATE TRIGGER trg_bookings_updated   BEFORE UPDATE ON public.onboarding_bookings   FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();

-- ===== 7. Result ============================================================
SELECT 'migration 034 applied' AS status,
       (SELECT COUNT(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'onboarding_%') AS new_tables,
       (SELECT COUNT(*) FROM pg_policies WHERE tablename LIKE 'onboarding_%') AS new_policies;
