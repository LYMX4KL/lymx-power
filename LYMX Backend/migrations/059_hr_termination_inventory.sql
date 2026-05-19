-- =============================================================================
-- Migration 059 — HR Phase E + X-cut: termination workflow + inventory master
-- 2026-05-19
-- =============================================================================
--
-- Mirror of InvestPro PM db/201 (termination) + db/206 (property) + db/207
-- (inventory master + auto-link).
--
-- Nevada NRS 608.020 / 608.030 final-pay timing baked into initiate_termination.
-- Dynamic property checklist pulls from staff_property_items (live, not JSONB).
-- Inventory master + auto-link trigger so every issued item gets an inventory
-- mirror.
--
-- Depends on migrations 055, 056, 057, 058.
-- =============================================================================


-- ---------- 1. termination_records ----------------------------------------
create table if not exists public.termination_records (
    id                   uuid primary key default gen_random_uuid(),
    profile_id           uuid not null references auth.users(id) on delete cascade,

    -- Initiation
    termination_type     text not null
                             check (termination_type in ('voluntary','involuntary','layoff','mutual','end_of_contract','retirement','no_show','death')),
    last_day_worked      date not null,
    reason               text not null,
    detailed_notes       text,
    eligible_for_rehire  boolean,

    -- Computed at insert
    nv_final_pay_due_by  date,                                       -- last_day_worked + 3 days if involuntary, + 7 days otherwise

    -- 7-stage workflow
    stage                text not null default 'initiated'
                             check (stage in (
                                 'initiated','notice_given','property_returned',
                                 'access_revoked','final_pay_processed',
                                 'exit_interview_done','closed'
                             )),
    notice_given_at      timestamptz,
    property_returned_at timestamptz,
    access_revoked_at    timestamptz,
    final_pay_paid_at    timestamptz,
    exit_interview_done_at timestamptz,
    closed_at            timestamptz,

    -- Final pay
    final_pay_gross_amount_cents int,
    unused_pto_hours_paid        numeric(6,2),                       -- e.g. 12.50 hours
    final_pay_method     text check (final_pay_method in ('direct_deposit','paper_check','wire') or final_pay_method is null),
    final_pay_notes      text,

    -- Exit interview
    exit_q1_what_went_well text,
    exit_q2_what_to_improve text,
    exit_q3_recommendation  text,
    exit_q4_anything_else   text,
    exit_conductor_id    uuid references auth.users(id) on delete set null,
    exit_conductor_notes text,
    exit_interview_skipped_at timestamptz,
    exit_interview_skipped_reason text,

    -- Reactivation
    reactivated_at       timestamptz,
    reactivated_by_id    uuid references auth.users(id) on delete set null,
    reactivation_reason  text,

    -- Audit
    initiated_by_id      uuid references auth.users(id) on delete set null,
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now()
);

create index if not exists idx_term_profile on public.termination_records(profile_id, created_at desc);
create index if not exists idx_term_stage   on public.termination_records(stage);


-- ---------- 2. inventory_items — master record of every physical thing -----
create table if not exists public.inventory_items (
    id                   uuid primary key default gen_random_uuid(),
    label                text not null,
    category             text not null
                             check (category in ('laptop','phone','tablet','keys','access_card','lockbox','headset','monitor','camera','printer','clothing','other')),
    serial_or_id         text,                                       -- vendor serial, badge id, etc.
    description          text,
    estimated_value_usd  numeric(10,2),

    -- Acquisition
    acquired_at          date,
    acquisition_cost_usd numeric(10,2),
    acquired_from        text,

    -- State
    status               text not null default 'available'
                             check (status in ('available','assigned','damaged','lost','written_off','retired')),
    current_holder_id    uuid references auth.users(id) on delete set null,
    current_holder_name  text,

    -- Disposal audit
    written_off_at       timestamptz,
    written_off_by_id    uuid references auth.users(id) on delete set null,
    written_off_reason   text,
    retired_at           timestamptz,
    retired_by_id        uuid references auth.users(id) on delete set null,
    retired_reason       text,

    -- Audit
    notes                text,
    created_at           timestamptz not null default now(),
    created_by_id        uuid references auth.users(id) on delete set null,
    updated_at           timestamptz not null default now()
);

create index if not exists idx_inv_status      on public.inventory_items(status);
create index if not exists idx_inv_category    on public.inventory_items(category);
create index if not exists idx_inv_holder      on public.inventory_items(current_holder_id);


-- ---------- 3. staff_property_items — per-staff equipment assignment ------
create table if not exists public.staff_property_items (
    id                    uuid primary key default gen_random_uuid(),
    profile_id            uuid not null references auth.users(id) on delete cascade,
    inventory_item_id     uuid references public.inventory_items(id) on delete set null,

    label                 text not null,
    category              text not null,
    serial_or_id          text,
    estimated_value_usd   numeric(10,2),
    is_required_return    boolean not null default true,             -- false for cheap stuff like branded swag

    -- Lifecycle
    issued_at             timestamptz not null default now(),
    issued_by_id          uuid references auth.users(id) on delete set null,
    issued_notes          text,
    returned_at           timestamptz,
    returned_condition    text check (returned_condition in ('good','damaged','lost') or returned_condition is null),
    returned_to_id        uuid references auth.users(id) on delete set null,

    disposition           text not null default 'in_possession'
                              check (disposition in ('in_possession','returned','outstanding','written_off')),

    -- Outstanding flag (set by close_termination)
    flagged_outstanding_at timestamptz,
    outstanding_termination_id uuid references public.termination_records(id) on delete set null,
    aged_alert_sent_at    timestamptz,
    written_off_at        timestamptz,
    written_off_reason    text,

    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now()
);

create index if not exists idx_spi_profile      on public.staff_property_items(profile_id, disposition);
create index if not exists idx_spi_outstanding  on public.staff_property_items(disposition) where disposition = 'outstanding';


-- ---------- 4. Auto-link trigger: staff_property_items → inventory_items --
-- BEFORE INSERT: if inventory_item_id is null, create a matching
-- inventory_items row and set the link.  If already linked, flip the
-- inventory row to 'assigned' + set holder.
create or replace function public.tg_link_inventory_on_assignment()
returns trigger language plpgsql security definer
as $$
declare
    v_inv_id uuid;
    v_name   text;
begin
    if new.inventory_item_id is null then
        -- Create matching inventory row
        select coalesce(raw_user_meta_data->>'full_name', email)
          into v_name from auth.users where id = new.profile_id;

        insert into public.inventory_items (
            label, category, serial_or_id, estimated_value_usd,
            status, current_holder_id, current_holder_name,
            created_by_id
        ) values (
            new.label, new.category, new.serial_or_id, new.estimated_value_usd,
            'assigned', new.profile_id, v_name,
            new.issued_by_id
        )
        returning id into v_inv_id;
        new.inventory_item_id := v_inv_id;
    else
        -- Link exists → flip to assigned
        select coalesce(raw_user_meta_data->>'full_name', email)
          into v_name from auth.users where id = new.profile_id;
        update public.inventory_items
           set status              = 'assigned',
               current_holder_id   = new.profile_id,
               current_holder_name = v_name,
               updated_at          = now()
         where id = new.inventory_item_id;
    end if;

    return new;
end$$;

drop trigger if exists trg_link_inventory_on_assignment on public.staff_property_items;
create trigger trg_link_inventory_on_assignment
    before insert on public.staff_property_items
    for each row execute function public.tg_link_inventory_on_assignment();


-- ---------- 5. Disposition-change → inventory sync trigger ----------------
create or replace function public.tg_sync_inventory_on_disposition()
returns trigger language plpgsql security definer
as $$
begin
    if new.disposition = old.disposition then
        return new;
    end if;
    if new.inventory_item_id is null then
        return new;
    end if;

    if new.disposition = 'returned' then
        update public.inventory_items
           set status              = case new.returned_condition
                                         when 'damaged' then 'damaged'
                                         when 'lost'    then 'lost'
                                         else 'available' end,
               current_holder_id   = null,
               current_holder_name = null,
               updated_at          = now()
         where id = new.inventory_item_id;
    elsif new.disposition = 'outstanding' then
        -- Outstanding: leave inventory as 'assigned' since item is still in their possession (just unauthorized)
        null;
    elsif new.disposition = 'written_off' then
        update public.inventory_items
           set status              = 'written_off',
               current_holder_id   = null,
               current_holder_name = null,
               written_off_at      = now(),
               written_off_by_id   = auth.uid(),
               written_off_reason  = new.written_off_reason,
               updated_at          = now()
         where id = new.inventory_item_id;
    end if;

    return new;
end$$;

drop trigger if exists trg_sync_inventory_on_disposition on public.staff_property_items;
create trigger trg_sync_inventory_on_disposition
    after update of disposition on public.staff_property_items
    for each row execute function public.tg_sync_inventory_on_disposition();


-- ---------- 6. outstanding_property_queue view ----------------------------
create or replace view public.outstanding_property_queue as
    select
        spi.id,
        spi.profile_id,
        coalesce(u.raw_user_meta_data->>'full_name', u.email) as holder_name,
        spi.label,
        spi.category,
        spi.estimated_value_usd,
        spi.flagged_outstanding_at,
        extract(day from now() - spi.flagged_outstanding_at)::int as days_outstanding,
        spi.outstanding_termination_id,
        tr.last_day_worked        as term_last_day,
        tr.termination_type
      from public.staff_property_items spi
      join auth.users u on u.id = spi.profile_id
 left join public.termination_records tr on tr.id = spi.outstanding_termination_id
     where spi.disposition = 'outstanding'
     order by spi.flagged_outstanding_at asc;

grant select on public.outstanding_property_queue to authenticated;


-- ---------- 7. RPCs: termination workflow ---------------------------------

-- 7a. initiate_termination — computes NV final-pay timing
create or replace function public.initiate_termination(
    p_profile_id            uuid,
    p_termination_type      text,
    p_last_day_worked       date,
    p_reason                text,
    p_detailed_notes        text default null,
    p_eligible_for_rehire   boolean default null
)
returns public.termination_records
language plpgsql security definer
as $$
declare
    v_row public.termination_records;
    v_final_due date;
begin
    if not public.am_i_hr_or_admin() then
        raise exception 'Only HR/admin/compliance can initiate termination';
    end if;

    -- NV final-pay timing
    if p_termination_type = 'involuntary' then
        v_final_due := p_last_day_worked + interval '3 days';   -- NRS 608.020
    else
        v_final_due := p_last_day_worked + interval '7 days';   -- NRS 608.030
    end if;

    insert into public.termination_records (
        profile_id, termination_type, last_day_worked, reason, detailed_notes,
        eligible_for_rehire, nv_final_pay_due_by, stage, initiated_by_id
    ) values (
        p_profile_id, p_termination_type, p_last_day_worked, p_reason, p_detailed_notes,
        p_eligible_for_rehire, v_final_due, 'initiated', auth.uid()
    )
    returning * into v_row;

    return v_row;
end$$;

-- 7b. Internal helper — flag outstanding property on close
create or replace function public.flag_outstanding_property_on_termination(
    p_termination_id uuid,
    p_profile_id     uuid
)
returns int
language plpgsql security definer
as $$
declare
    v_count int;
begin
    update public.staff_property_items
       set disposition                = 'outstanding',
           flagged_outstanding_at     = now(),
           outstanding_termination_id = p_termination_id
     where profile_id = p_profile_id
       and disposition = 'in_possession'
       and is_required_return = true;

    get diagnostics v_count = row_count;
    return v_count;
end$$;

-- 7c. close_termination — also flags outstanding property + can deactivate
create or replace function public.close_termination(
    p_id                  uuid,
    p_deactivate_profile  boolean default true
)
returns jsonb
language plpgsql security definer
as $$
declare
    v_row public.termination_records;
    v_outstanding int;
begin
    if not public.am_i_hr_or_admin() then
        raise exception 'Only HR/admin/compliance can close terminations';
    end if;

    select * into v_row from public.termination_records where id = p_id;
    if v_row.id is null then raise exception 'Termination record not found'; end if;
    if v_row.stage = 'closed' then raise exception 'Already closed'; end if;

    -- Flag outstanding property
    v_outstanding := public.flag_outstanding_property_on_termination(p_id, v_row.profile_id);

    update public.termination_records
       set stage             = 'closed',
           closed_at         = now(),
           access_revoked_at = coalesce(access_revoked_at, now())
     where id = p_id;

    -- Deactivate the staff_profiles row + flip employment_status
    if p_deactivate_profile then
        update public.staff_profiles
           set employment_status = 'terminated',
               termination_date  = v_row.last_day_worked
         where user_id = v_row.profile_id;
    end if;

    return jsonb_build_object(
        'termination_id', p_id,
        'outstanding_items_flagged', v_outstanding,
        'closed_at', now(),
        'deactivated', p_deactivate_profile
    );
end$$;

-- 7d. skip_exit_interview
create or replace function public.skip_exit_interview(p_id uuid, p_reason text)
returns public.termination_records
language plpgsql security definer
as $$
declare
    v_row public.termination_records;
begin
    if not (public.am_i_hr_or_admin() OR public.am_i_accounting()) then
        raise exception 'Only HR/admin/compliance/accounting can skip exit interview';
    end if;

    update public.termination_records
       set exit_interview_skipped_at = now(),
           exit_interview_skipped_reason = p_reason,
           exit_interview_done_at = now(),
           stage = 'exit_interview_done',
           exit_conductor_id = auth.uid()
     where id = p_id
    returning * into v_row;
    return v_row;
end$$;

-- 7e. reactivate_staff — reverses close_termination
create or replace function public.reactivate_staff(p_termination_id uuid, p_reason text)
returns public.termination_records
language plpgsql security definer
as $$
declare
    v_row public.termination_records;
begin
    if not public.am_i_hr_or_admin() then
        raise exception 'Only HR/admin/compliance can reactivate';
    end if;

    select * into v_row from public.termination_records where id = p_termination_id;
    if v_row.id is null then raise exception 'Termination not found'; end if;

    update public.staff_profiles
       set employment_status = 'active',
           termination_date  = null
     where user_id = v_row.profile_id;

    update public.termination_records
       set reactivated_at      = now(),
           reactivated_by_id   = auth.uid(),
           reactivation_reason = p_reason
     where id = p_termination_id
    returning * into v_row;

    -- NOTE: clearing the auth.users ban must happen via Edge Function
    -- (reactivate-staff EF). This RPC only updates DB state.
    return v_row;
end$$;


-- ---------- 8. RLS --------------------------------------------------------
alter table public.termination_records    enable row level security;
alter table public.staff_property_items   enable row level security;
alter table public.inventory_items        enable row level security;

-- termination_records: staff sees own; HR/admin all
drop policy if exists term_self_read on public.termination_records;
create policy term_self_read on public.termination_records for select to authenticated
    using (profile_id = auth.uid());

drop policy if exists term_hr_all on public.termination_records;
create policy term_hr_all on public.termination_records for all to authenticated
    using (public.am_i_hr_or_admin())
    with check (public.am_i_hr_or_admin());

-- staff_property_items: staff sees own; HR/admin/accounting all
drop policy if exists spi_self_read on public.staff_property_items;
create policy spi_self_read on public.staff_property_items for select to authenticated
    using (profile_id = auth.uid());

drop policy if exists spi_hr_all on public.staff_property_items;
create policy spi_hr_all on public.staff_property_items for all to authenticated
    using (public.am_i_hr_or_admin() OR public.am_i_accounting())
    with check (public.am_i_hr_or_admin() OR public.am_i_accounting());

-- inventory_items: HR/admin/accounting only
drop policy if exists inv_hr_all on public.inventory_items;
create policy inv_hr_all on public.inventory_items for all to authenticated
    using (public.am_i_hr_or_admin() OR public.am_i_accounting())
    with check (public.am_i_hr_or_admin() OR public.am_i_accounting());


-- ---------- 9. Grants ----------------------------------------------------
grant select on public.termination_records   to authenticated;
grant select on public.staff_property_items  to authenticated;
grant select on public.inventory_items       to authenticated;

grant execute on function public.initiate_termination(uuid,text,date,text,text,boolean) to authenticated;
grant execute on function public.flag_outstanding_property_on_termination(uuid,uuid) to authenticated;
grant execute on function public.close_termination(uuid,boolean) to authenticated;
grant execute on function public.skip_exit_interview(uuid,text) to authenticated;
grant execute on function public.reactivate_staff(uuid,text) to authenticated;

grant all on public.termination_records  to service_role;
grant all on public.staff_property_items to service_role;
grant all on public.inventory_items      to service_role;


-- ---------- 10. Sanity ---------------------------------------------------
do $$ begin
    if not exists (select 1 from pg_proc where proname='am_i_hr_or_admin' and pg_function_is_visible(oid)) then
        raise exception 'am_i_hr_or_admin missing — apply migration 055 first';
    end if;
end$$;
