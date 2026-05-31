-- =============================================================================
-- Migration 170 — bookings: let the booker read their own booking by EMAIL
-- =============================================================================
-- Bug (#58): "Confirmed Bookings Are Not Displayed in My Bookings Page."
--
-- Root cause: bookings are inserted by the book-call Edge Function (service
-- role), and for guest / email-only bookers the row's booker_user_id is NULL
-- (or doesn't equal the signed-in user). The ONLY booker read policy on
-- public.bookings is:
--     bookings_booker_read  USING (booker_user_id = auth.uid())
-- so a booking whose booker_user_id is NULL / mismatched is invisible to the
-- person who made it. my-bookings.html DOES query by booker_email (ilike), but
-- RLS has no email-based read policy, so that query returns nothing — the
-- booking exists but the booker can never see it.
--
-- This is the same identity-resolution gap migration 086 already fixed for
-- event_rsvps (read by user_id OR jwt email). bookings was never given the
-- email path. Mirror 086 here. (ARCHITECTURE-RULES Rule 7 — server identity
-- resolution must match the frontend's: user_id OR email.)
--
-- Fix: add a booker-email read policy using auth.jwt() ->> 'email' (no
-- auth.users subselect — the authenticated role can't read auth.users in an
-- RLS context; that was the 085->086 lesson). Case-insensitive to match the
-- lower(booker_email) index and the frontend's ilike. The existing
-- booker_user_id and calendar-owner / admin policies are left intact (RLS
-- policies are OR-ed, so this only ADDS visibility — never removes any).
-- =============================================================================

drop policy if exists bookings_booker_email_read on public.bookings;
create policy bookings_booker_email_read on public.bookings
    for select to authenticated
    using (
        booker_email is not null
        and lower(booker_email) = lower(auth.jwt() ->> 'email')
    );

-- Sanity check
do $sanity$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'bookings'
      and policyname = 'bookings_booker_email_read'
  ) then
    raise exception 'Migration 170 failed: bookings_booker_email_read policy not created';
  end if;
  raise notice 'Migration 170 OK — bookers can now read their own bookings by email (fixes #58).';
end $sanity$;
