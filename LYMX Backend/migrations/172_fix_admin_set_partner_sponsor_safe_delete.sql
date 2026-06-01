-- =============================================================================
-- Migration 172 — fix admin_set_partner_sponsor: remove WHERE-less DELETE
-- =============================================================================
-- Bug (found by Kenny's live test, ticket "partner move it not working"):
-- calling admin_set_partner_sponsor on a real partner failed with
--     ERROR 21000: DELETE requires a WHERE clause
-- This DB runs in safe-update mode, which rejects any DELETE/UPDATE without a
-- WHERE clause. Migration 171 used a temp table and cleared it with
--     delete from _moved_desc;        -- <-- no WHERE → blocked
-- Migration 171's bogus-id existence probe never reached that line (it raised
-- "Partner not found" first), which is why the function looked deployed/working
-- but failed on every real move.
--
-- Fix (root cause): drop the temp table entirely. Capture the moved partner's
-- descendants into a uuid[] array, then rebuild each one — every DELETE now has
-- a WHERE clause. Behaviour is otherwise identical to 171: moving a partner
-- carries the whole downline; the moved node + every descendant get their
-- mgc_tree chains rebuilt; self-sponsor and genealogy loops are rejected.
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
    v_partner      public.partners%rowtype;
    v_sponsor      public.partners%rowtype;
    v_cursor       uuid;
    v_depth        int := 0;
    v_descendants  uuid[];
    v_desc         uuid;
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
    -- chains run through this partner and must be rebuilt afterward). Array, not
    -- a temp table — avoids any WHERE-less DELETE (safe-update mode rejects it).
    select array_agg(descendant_id)
      into v_descendants
      from public.mgc_tree
     where ancestor_id = p_partner_id;

    -- The move. The AFTER-UPDATE trigger rebuilds THIS partner's own edges.
    update public.partners
       set sponsor_partner_id = p_sponsor_partner_id
     where id = p_partner_id;

    -- Cascade: rebuild every descendant's full chain through the new path.
    if v_descendants is not null then
        foreach v_desc in array v_descendants loop
            delete from public.mgc_tree where descendant_id = v_desc;   -- WHERE present
            perform public.refresh_partner_tree(v_desc);
        end loop;
    end if;

    return jsonb_build_object(
        'ok', true,
        'partner_id', p_partner_id,
        'partner_code', v_partner.partner_code,
        'sponsor_partner_id', p_sponsor_partner_id,
        'sponsor_code', case when p_sponsor_partner_id is null then null else v_sponsor.partner_code end,
        'descendants_rebuilt', coalesce(array_length(v_descendants, 1), 0)
    );
end;
$fn$;

grant execute on function public.admin_set_partner_sponsor(uuid, uuid) to authenticated;

-- Sanity
do $sanity$
begin
  if not exists (select 1 from pg_proc where proname = 'admin_set_partner_sponsor') then
    raise exception 'Migration 172 failed: admin_set_partner_sponsor missing';
  end if;
  raise notice 'Migration 172 OK — admin_set_partner_sponsor no longer uses a WHERE-less DELETE.';
end $sanity$;
