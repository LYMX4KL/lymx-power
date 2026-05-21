-- =============================================================================
-- Migration 066 — backfill partners.avatar_url from customers.avatar_url
--
-- 2026-05-21 (v1) — direct UPDATE — failed with "relation public.partners does not exist"
-- 2026-05-21 (v2) — same root cause as migration 065: the Supabase SQL editor's
--                   session can't resolve public.* references at statement parse
--                   time (Postgres catalog visibility quirk for the dashboard
--                   role). The canonical fix is the SECURITY DEFINER pattern —
--                   wrap the work in a function whose body is parsed lazily at
--                   call time with the function's own search_path.
-- =============================================================================
--
-- Ticket #aebedf90 — Rae uploaded her avatar while she was a customer, so it
-- landed in customers.avatar_url. After she upgraded to partner, the new
-- partners row had avatar_url = NULL. The profile + rep-dashboard pages read
-- partners.avatar_url first (since detectRole() returns 'partner' once she
-- has both rows), so her avatar appeared to "disappear" once role detection
-- resolved.
--
-- This is a ONE-TIME backfill — going forward, profile.html now writes the
-- avatar_url to BOTH rows on every upload (see commit fixing #aebedf90 in
-- profile.html uploadAvatar()). So this function only needs to run once.
-- =============================================================================

-- 1) The SECURITY DEFINER backfill function. SET search_path on the function
--    so its body resolves public.* correctly at execution time.
create or replace function public._backfill_partner_avatars_aebedf90()
returns table(display_name text, user_id uuid, now_set boolean)
language plpgsql
security definer
set search_path = public
as $backfill_partner_avatars_aebedf90$
begin
    return query
    update public.partners p
       set avatar_url = c.avatar_url,
           updated_at = now()
      from public.customers c
     where c.user_id = p.user_id
       and c.avatar_url is not null
       and p.avatar_url is null
    returning p.display_name, p.user_id, p.avatar_url is not null;
end
$backfill_partner_avatars_aebedf90$;

-- Lock down — this is admin-only, no anon/authenticated execute.
revoke all on function public._backfill_partner_avatars_aebedf90() from public;

-- 2) Run the backfill. The returned rows are the partners that got updated.
select * from public._backfill_partner_avatars_aebedf90();

-- 3) Verify Rae's partner row has the URL after backfill:
select display_name, avatar_url is not null as has_avatar
  from public.partners
 where user_id = '2d32a692-5739-47d6-b7eb-43b5c3202b5e';

-- 4) Drop the helper — it's one-time, no reason to keep it around.
drop function if exists public._backfill_partner_avatars_aebedf90();
