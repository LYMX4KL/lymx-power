-- =============================================================================
-- Migration 171 — admin_set_partner_sponsor (admin places / moves a partner)
-- =============================================================================
-- Lets an admin (Helen / Kenny) set or change a partner's sponsor (upline) —
-- e.g. to place a partner whose invite link wasn't used, or move a partner to
-- the correct downline after verifying their claim.
--
-- Why an RPC (not a direct PATCH): partners has no admin-UPDATE RLS policy, so a
-- direct update silently affects 0 rows (ARCHITECTURE-RULES — admin mutations go
-- through a SECURITY DEFINER RPC gated on am_i_admin()).
--
-- Correctness: partners.sponsor_partner_id drives the mgc_tree genealogy, which
-- drives override-commission eligibility. The existing trigger rebuilds ONLY the
-- moved partner's own ancestor edges — NOT their descendants', whose chains run
-- *through* the moved partner and therefore go stale on a move. This RPC cascades
-- the rebuild to the moved partner AND every descendant, so the whole subtree is
-- correct afterward. Guards against self-sponsor and genealogy loops.
-- =============================================================================

create or replace function public.admin_set_partner_sponsor(
    p_partner_id          uuid,
    p_sponsor_partner_id  uuid   -- pass NULL to clear the sponsor (make a root)
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
    v_partner   public.partners%rowtype;
    v_sponsor   public.partners%rowtype;
    v_cursor    uuid;
    v_depth     int := 0;
    v_desc      uuid;
begin
    -- Admin only.
    if not public.am_i_admin() then
        raise exception 'Permission denied: admin only';
    end if;

    select * into v_partner from public.partners where id = p_partner_id;
    if not found then
        raise exception 'Partner % not found', p_partner_id;
    end if;

    if p_sponsor_partner_id is not null then
        if p_sponsor_partner_id = p_partner_id then
            raise exception 'A partner cannot be their own sponsor';
        end if;
        select * into v_sponsor from public.partners where id = p_sponsor_partner_id;
        if not found then
            raise exception 'Sponsor % not found', p_sponsor_partner_id;
        end if;
        -- Loop guard: walk UP the proposed sponsor's chain. If it reaches the
        -- partner we're moving, the move would create a cycle.
        v_cursor := p_sponsor_partner_id;
        while v_cursor is not null and v_depth < 100 loop
            if v_cursor = p_partner_id then
                raise exception 'Cannot set sponsor: would create a loop in the genealogy';
            end if;
            select sponsor_partner_id into v_cursor from public.partners where id = v_cursor;
            v_depth := v_depth + 1;
        end loop;
    end if;

    -- Capture the moved partner's descendants BEFORE the change (their ancestor
    -- chains run through this partner and must be rebuilt afterward).
    create temporary table if not exists _moved_desc (id uuid) on commit drop;
    delete from _moved_desc;
    insert into _moved_desc (id)
        select descendant_id from public.mgc_tree where ancestor_id = p_partner_id;

    -- The move. The AFTER-UPDATE trigger rebuilds THIS partner's own edges.
    update public.partners
       set sponsor_partner_id = p_sponsor_partner_id
     where id = p_partner_id;

    -- Cascade: rebuild every descendant's full chain through the new path.
    for v_desc in select id from _moved_desc loop
        delete from public.mgc_tree where descendant_id = v_desc;
        perform public.refresh_partner_tree(v_desc);
    end loop;

    return jsonb_build_object(
        'ok', true,
        'partner_id', p_partner_id,
        'partner_code', v_partner.partner_code,
        'sponsor_partner_id', p_sponsor_partner_id,
        'sponsor_code', case when p_sponsor_partner_id is null then null else v_sponsor.partner_code end,
        'descendants_rebuilt', (select count(*) from _moved_desc)
    );
end;
$fn$;

grant execute on function public.admin_set_partner_sponsor(uuid, uuid) to authenticated;

-- Sanity
do $sanity$
begin
  if not exists (select 1 from pg_proc where proname = 'admin_set_partner_sponsor') then
    raise exception 'Migration 171 failed: admin_set_partner_sponsor not created';
  end if;
  raise notice 'Migration 171 OK — admin_set_partner_sponsor ready (admin places/moves partners; cascades mgc_tree rebuild).';
end $sanity$;
