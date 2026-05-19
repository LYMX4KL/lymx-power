-- =============================================================================
-- Migration 015 — Internal staff roles + change-request approval workflow
-- =============================================================================
-- Implements Kenny's operator-configurable principle: marketing/support/tech/
-- finance staff propose changes via UI, admin approves via UI, all without
-- code changes. Audit trail mandatory.
--
-- The 3 EXTERNAL roles (customer / business / partner) stay in their existing
-- structure. INTERNAL staff roles are separate, layered on top of auth.users.
-- =============================================================================

-- =====================================================================
-- 1. staff_roles — who can do what internally
-- =====================================================================
create table if not exists public.staff_roles (
    user_id     uuid primary key references auth.users(id) on delete cascade,
    role        text not null check (role in ('admin','marketing','support','tech','finance','observer')),
    granted_by  uuid references auth.users(id),
    granted_at  timestamptz not null default now(),
    notes       text
);

create index if not exists idx_staff_roles_role on public.staff_roles(role);

-- Seed Kenny as admin
insert into public.staff_roles (user_id, role, notes)
values ('1405bb50-2c97-48dd-bfa5-31f32320de9b'::uuid, 'admin', 'Founder')
on conflict (user_id) do update set role = 'admin';

-- Helper: is the current user a staff member with at least this role?
create or replace function public.has_staff_role(p_role text)
returns boolean
language sql stable
as $$
  select exists (
    select 1 from public.staff_roles
     where user_id = auth.uid()
       and (role = p_role
            or (role = 'admin')
            or (p_role = 'observer'))
  )
$$;

create or replace function public.am_i_admin()
returns boolean
language sql stable
as $$
  select exists (
    select 1 from public.staff_roles
     where user_id = auth.uid() and role = 'admin'
  )
$$;

create or replace function public.my_staff_role()
returns text
language sql stable
as $$
  select role from public.staff_roles where user_id = auth.uid() limit 1
$$;

grant execute on function public.has_staff_role(text), public.am_i_admin(), public.my_staff_role() to authenticated, anon;

alter table public.staff_roles enable row level security;

drop policy if exists staff_roles_admin_all on public.staff_roles;
create policy staff_roles_admin_all on public.staff_roles for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

drop policy if exists staff_roles_self_read on public.staff_roles;
create policy staff_roles_self_read on public.staff_roles for select to authenticated
    using (user_id = auth.uid());

grant select, insert, update, delete on public.staff_roles to authenticated;


-- =====================================================================
-- 2. change_requests — pending change proposals (the approval queue)
-- =====================================================================
create table if not exists public.change_requests (
    id              uuid primary key default uuid_generate_v4(),

    -- What's being changed
    request_type    text not null,
    target_table    text not null,
    target_id       text,                              -- text so it can hold UUIDs OR slugs OR keys
    field_path      text,                              -- e.g. 'amount_lymx' or 'signup_bonus_from_lymx'

    -- Before / after
    current_value   jsonb,
    proposed_value  jsonb not null,

    -- Context
    rationale       text,
    business_impact text,

    -- Workflow state
    status          text not null default 'pending'
                    check (status in ('pending','approved','rejected','withdrawn','applied','failed')),

    -- Who
    proposed_by     uuid not null references auth.users(id) on delete restrict,
    proposed_by_role text,
    proposed_at     timestamptz not null default now(),

    reviewed_by     uuid references auth.users(id),
    reviewed_by_role text,
    reviewed_at     timestamptz,
    review_notes    text,

    applied_at      timestamptz,
    apply_error     text,

    -- Optional expiration (auto-withdraw if not approved by then)
    expires_at      timestamptz
);

create index if not exists idx_change_requests_pending on public.change_requests(status, proposed_at desc) where status = 'pending';
create index if not exists idx_change_requests_target  on public.change_requests(target_table, target_id);
create index if not exists idx_change_requests_proposer on public.change_requests(proposed_by, proposed_at desc);

alter table public.change_requests enable row level security;

-- Admin: full power
drop policy if exists change_requests_admin_all on public.change_requests;
create policy change_requests_admin_all on public.change_requests for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- Any authenticated staff can SUBMIT new requests
drop policy if exists change_requests_staff_insert on public.change_requests;
create policy change_requests_staff_insert on public.change_requests for insert to authenticated
    with check (
        public.my_staff_role() is not null
        and proposed_by = auth.uid()
    );

-- Anyone can READ their own submitted requests
drop policy if exists change_requests_self_read on public.change_requests;
create policy change_requests_self_read on public.change_requests for select to authenticated
    using (proposed_by = auth.uid());

-- Submitter can WITHDRAW their own pending request
drop policy if exists change_requests_self_withdraw on public.change_requests;
create policy change_requests_self_withdraw on public.change_requests for update to authenticated
    using (proposed_by = auth.uid() and status = 'pending')
    with check (proposed_by = auth.uid() and status in ('pending','withdrawn'));

grant select, insert, update on public.change_requests to authenticated;


-- =====================================================================
-- 3. Helper RPC: submit a change request from an operator UI
-- =====================================================================
create or replace function public.submit_change_request(
    p_request_type    text,
    p_target_table    text,
    p_target_id       text,
    p_field_path      text,
    p_proposed_value  jsonb,
    p_current_value   jsonb default null,
    p_rationale       text default null,
    p_business_impact text default null
) returns uuid
language plpgsql
security definer
as $$
declare
    new_id uuid;
    my_role text;
begin
    select role into my_role from public.staff_roles where user_id = auth.uid() limit 1;
    if my_role is null then
        raise exception 'Only staff members can submit change requests';
    end if;

    insert into public.change_requests (
        request_type, target_table, target_id, field_path,
        current_value, proposed_value, rationale, business_impact,
        proposed_by, proposed_by_role
    ) values (
        p_request_type, p_target_table, p_target_id, p_field_path,
        p_current_value, p_proposed_value, p_rationale, p_business_impact,
        auth.uid(), my_role
    )
    returning id into new_id;

    return new_id;
end;
$$;

grant execute on function public.submit_change_request(text, text, text, text, jsonb, jsonb, text, text) to authenticated;


-- =====================================================================
-- 4. Helper RPC: admin approves a change request (and applies it)
-- =====================================================================
create or replace function public.approve_change_request(
    p_request_id  uuid,
    p_notes       text default null
) returns json
language plpgsql
security definer
as $$
declare
    req record;
    sql_stmt text;
    err text;
begin
    if not public.am_i_admin() then
        raise exception 'Only admins can approve change requests';
    end if;

    select * into req from public.change_requests where id = p_request_id and status = 'pending';
    if not found then
        raise exception 'Change request not found or not pending';
    end if;

    -- Apply the change based on target_table
    begin
        if req.target_table = 'platform_promos' then
            update public.platform_promos
               set amount_lymx = (req.proposed_value->>'amount_lymx')::int,
                   active      = coalesce((req.proposed_value->>'active')::boolean, active),
                   description = coalesce(req.proposed_value->>'description', description)
             where promo_key = req.target_id;

        elsif req.target_table = 'business_partners' then
            update public.business_partners
               set signup_bonus_from_lymx = coalesce((req.proposed_value->>'signup_bonus_from_lymx')::int, signup_bonus_from_lymx),
                   signup_bonus_from_biz  = coalesce((req.proposed_value->>'signup_bonus_from_biz')::int, signup_bonus_from_biz),
                   bonus_cents_per_lymx   = coalesce((req.proposed_value->>'bonus_cents_per_lymx')::int, bonus_cents_per_lymx),
                   max_signups_per_hour   = coalesce((req.proposed_value->>'max_signups_per_hour')::int, max_signups_per_hour),
                   active                 = coalesce((req.proposed_value->>'active')::boolean, active)
             where slug = req.target_id;

        else
            raise exception 'Unknown target_table: %', req.target_table;
        end if;

        update public.change_requests
           set status = 'applied',
               reviewed_by = auth.uid(),
               reviewed_by_role = 'admin',
               reviewed_at = now(),
               review_notes = p_notes,
               applied_at = now()
         where id = p_request_id;

        return json_build_object('success', true, 'request_id', p_request_id, 'applied', true);

    exception when others then
        get stacked diagnostics err = MESSAGE_TEXT;
        update public.change_requests
           set status = 'failed',
               reviewed_by = auth.uid(),
               reviewed_by_role = 'admin',
               reviewed_at = now(),
               review_notes = p_notes,
               apply_error = err
         where id = p_request_id;
        return json_build_object('success', false, 'request_id', p_request_id, 'error', err);
    end;
end;
$$;

grant execute on function public.approve_change_request(uuid, text) to authenticated;


-- =====================================================================
-- 5. Helper RPC: admin rejects a change request
-- =====================================================================
create or replace function public.reject_change_request(
    p_request_id uuid,
    p_notes      text default null
) returns boolean
language plpgsql
security definer
as $$
begin
    if not public.am_i_admin() then
        raise exception 'Only admins can reject change requests';
    end if;

    update public.change_requests
       set status = 'rejected',
           reviewed_by = auth.uid(),
           reviewed_by_role = 'admin',
           reviewed_at = now(),
           review_notes = p_notes
     where id = p_request_id
       and status = 'pending';

    return found;
end;
$$;

grant execute on function public.reject_change_request(uuid, text) to authenticated;


-- =====================================================================
-- 6. Update platform_promos RLS — marketing can READ but not directly UPDATE
-- =====================================================================
-- Drop the old admin-only policy and replace with role-aware ones
drop policy if exists promos_admin_all on public.platform_promos;

create policy promos_admin_all on public.platform_promos for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- Marketing can read (so they can see current values when proposing changes)
drop policy if exists promos_marketing_read on public.platform_promos;
create policy promos_marketing_read on public.platform_promos for select to authenticated
    using (public.has_staff_role('marketing') or public.has_staff_role('finance'));


-- =====================================================================
-- 7. View: pending changes with proposer info
-- =====================================================================
create or replace view public.v_pending_changes as
select
    cr.id,
    cr.request_type,
    cr.target_table,
    cr.target_id,
    cr.field_path,
    cr.current_value,
    cr.proposed_value,
    cr.rationale,
    cr.business_impact,
    cr.proposed_by_role,
    cr.proposed_at,
    u.email as proposed_by_email
from public.change_requests cr
left join auth.users u on u.id = cr.proposed_by
where cr.status = 'pending'
order by cr.proposed_at desc;

grant select on public.v_pending_changes to authenticated;


-- =====================================================================
-- 8. Verify
-- =====================================================================
select role, count(*) from public.staff_roles group by role;
select 'staff_roles' as t, count(*) from public.staff_roles
union all select 'change_requests', count(*) from public.change_requests
union all select 'v_pending_changes', count(*) from public.v_pending_changes;

-- =============================================================================
-- End of migration 015
-- =============================================================================
