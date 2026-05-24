-- =============================================================================
-- Migration 080 — mgc_tree autopopulate + backfill (root-cause fix for #32be3a4c #f2f63c67)
-- =============================================================================
-- The Issue
-- ---------
-- partners.sponsor_partner_id is correctly set when a new partner signs up via
-- ?ref=. But the partner_downline_read RLS policy (002_rls_policies.sql line 99)
-- gates downline reads on rows in the mgc_tree closure table. mgc_tree is EMPTY
-- (zero rows total across the whole table as of 2026-05-24), so even though
-- Dave's recent test partners P-000106 and P-000107 have sponsor_partner_id =
-- Dave, his partner-tree.html query returns nothing because RLS denies the read.
--
-- The 001_initial_schema.sql comment on mgc_tree says "Insert all 4 ancestors
-- when a new partner signs up" — but nothing was ever wired up to do that.
--
-- The Fix
-- -------
-- Two parts, both SECURITY DEFINER so they work regardless of caller's RLS:
--
-- 1) public.refresh_partner_tree(p_partner_id uuid) — walks up the
--    sponsor_partner_id chain from a given partner and inserts up to 4 ancestor
--    edges into mgc_tree (gen 1..4). Idempotent via ON CONFLICT DO NOTHING.
--
-- 2) trg_partner_tree_upsert — AFTER INSERT OR UPDATE OF sponsor_partner_id ON
--    partners. Calls refresh_partner_tree for the affected row so new sign-ups
--    auto-populate the closure.
--
-- 3) Backfill block — runs refresh_partner_tree for every existing partner row.
--
-- After this migration:
--   - Dave's partner-tree.html will see P-000106 + P-000107 under him.
--   - Kenny's tree will see his 4 directs (P-000102/103/104/105) at G1.
--   - Any new signup with ?ref= auto-populates mgc_tree via the trigger.
-- =============================================================================

set search_path = public, pg_temp;

-- ----- 1. refresh function -----
create or replace function public.refresh_partner_tree(p_partner_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $refresh$
declare
    v_current uuid := p_partner_id;
    v_ancestor uuid;
    v_gen integer := 0;
begin
    if v_current is null then return; end if;

    -- Walk up the sponsor chain at most 4 generations.
    loop
        select sponsor_partner_id
          into v_ancestor
          from public.partners
         where id = v_current
         limit 1;

        exit when v_ancestor is null;

        v_gen := v_gen + 1;
        exit when v_gen > 4;

        insert into public.mgc_tree (ancestor_id, descendant_id, generation)
        values (v_ancestor, p_partner_id, v_gen)
        on conflict (ancestor_id, descendant_id) do update
            set generation = excluded.generation;

        v_current := v_ancestor;
    end loop;
end;
$refresh$;

comment on function public.refresh_partner_tree(uuid) is
  'Walks up the sponsor_partner_id chain from p_partner_id and writes up to 4 ancestor->descendant edges into mgc_tree. Idempotent. Called by trg_partner_tree_upsert on every partners INSERT/UPDATE OF sponsor_partner_id.';


-- ----- 2. trigger -----
create or replace function public.trg_partner_tree_upsert_fn()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $trg$
begin
    -- On INSERT: always refresh.
    -- On UPDATE: only refresh when sponsor changed (cheap guard).
    if tg_op = 'INSERT' then
        perform public.refresh_partner_tree(new.id);
    elsif tg_op = 'UPDATE' then
        if (old.sponsor_partner_id is distinct from new.sponsor_partner_id) then
            -- Sponsor changed — wipe stale ancestors then re-insert.
            delete from public.mgc_tree where descendant_id = new.id;
            perform public.refresh_partner_tree(new.id);
        end if;
    end if;
    return new;
end;
$trg$;

drop trigger if exists trg_partner_tree_upsert on public.partners;
create trigger trg_partner_tree_upsert
after insert or update of sponsor_partner_id on public.partners
for each row execute function public.trg_partner_tree_upsert_fn();


-- ----- 3. backfill existing partners -----
-- Walk every partner row through refresh_partner_tree. Idempotent — safe to re-run.
do $backfill$
declare
    r record;
    v_count integer := 0;
begin
    for r in select id from public.partners order by created_at asc loop
        perform public.refresh_partner_tree(r.id);
        v_count := v_count + 1;
    end loop;
    raise notice 'mgc_tree backfill: processed % partner rows', v_count;
end;
$backfill$;


-- ----- 4. grants -----
-- The function is SECURITY DEFINER so callers don't need direct mgc_tree
-- INSERT rights. Trigger fires on the partners table which is already
-- INSERT-able by signed-in users via separate self-insert policies.
grant execute on function public.refresh_partner_tree(uuid) to authenticated, anon, service_role;


-- ----- 5. sanity check (optional, will show row count in migration output) -----
do $check$
declare
    v_partners_with_sponsor integer;
    v_mgc_tree_rows integer;
begin
    select count(*) into v_partners_with_sponsor from public.partners where sponsor_partner_id is not null;
    select count(*) into v_mgc_tree_rows from public.mgc_tree;
    raise notice 'After backfill: partners_with_sponsor=% mgc_tree_rows=% (expect mgc_tree_rows >= partners_with_sponsor)',
        v_partners_with_sponsor, v_mgc_tree_rows;
end;
$check$;
