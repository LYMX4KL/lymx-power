-- =============================================================================
-- Migration 145 — fn_import_timesheet_line: bulk/Excel timesheet import
-- =============================================================================
-- Helen pays hourly staff (Dave, Rachel) from an Excel timesheet rather than
-- clock-in events. The payroll-reconciliation page reads APPROVED rows in
-- public.timesheet_lines. This RPC lets the admin importer page insert/upsert a
-- payable, pre-approved line per (staff email, work_date), computing pay
-- server-side so the math is authoritative (OT at 1.5x). Idempotent per
-- (user_id, work_date) — re-importing the same day overwrites, never dupes.
-- Admin or hr_admin only. Returns the resolved staff + computed gross.
-- =============================================================================

set local statement_timeout = 0;
begin;

create or replace function public.fn_import_timesheet_line(
    p_email          text,
    p_work_date      date,
    p_regular_hours  numeric,
    p_ot_hours       numeric default 0,
    p_hourly_rate    numeric default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $imp$
declare
    v_uid        uuid;
    v_name       text;
    v_rate       numeric;
    v_reg_min    int;
    v_ot_min     int;
    v_reg_pay    numeric;
    v_ot_pay     numeric;
    v_gross      numeric;
    v_actor      text;
begin
    -- authorization: admin or hr_admin only
    if not (public.am_i_admin() or public.has_permission('hr_admin')) then
        raise exception 'fn_import_timesheet_line: not authorized (admin / hr_admin only)';
    end if;
    if p_email is null or p_email = '' then raise exception 'email required'; end if;
    if p_work_date is null then raise exception 'work_date required'; end if;
    if coalesce(p_regular_hours,0) < 0 or coalesce(p_ot_hours,0) < 0 then
        raise exception 'hours cannot be negative';
    end if;

    -- resolve staff auth user by email
    select id into v_uid from auth.users where lower(email) = lower(trim(p_email)) limit 1;
    if v_uid is null then
        return jsonb_build_object('ok', false, 'email', p_email, 'error', 'no account found for this email');
    end if;

    -- rate: explicit beats the profile rate (only if profile pay is hourly)
    v_rate := coalesce(p_hourly_rate,
        (select case when pay_period = 'hour' or pay_type = 'hourly'
                     then pay_rate_cents / 100.0 end
           from public.staff_profiles where user_id = v_uid limit 1),
        0);

    v_name := coalesce(
        (select coalesce(display_name, legal_name) from public.partners where user_id = v_uid limit 1),
        split_part(p_email, '@', 1));

    v_reg_min := round(coalesce(p_regular_hours,0) * 60);
    v_ot_min  := round(coalesce(p_ot_hours,0) * 60);
    v_reg_pay := round(coalesce(p_regular_hours,0) * v_rate, 2);
    v_ot_pay  := round(coalesce(p_ot_hours,0) * v_rate * 1.5, 2);   -- OT at time-and-a-half
    v_gross   := v_reg_pay + v_ot_pay;
    v_actor   := coalesce((select coalesce(display_name, legal_name) from public.partners where user_id = auth.uid() limit 1), 'HR import');

    insert into public.timesheet_lines (
        user_id, user_name_snapshot, work_date,
        raw_minutes_in_shift, paid_minutes,
        daily_regular_minutes, final_regular_minutes,
        daily_ot_minutes, final_ot_minutes,
        hourly_rate_usd, estimated_regular_pay_usd, estimated_ot_pay_usd, estimated_gross_usd,
        edited_by_id, edited_by_name, edit_reason,
        approved_by_id, approved_by_name, approved_at, updated_at
    ) values (
        v_uid, v_name, p_work_date,
        v_reg_min + v_ot_min, v_reg_min + v_ot_min,
        v_reg_min, v_reg_min,
        v_ot_min, v_ot_min,
        v_rate, v_reg_pay, v_ot_pay, v_gross,
        auth.uid(), v_actor, 'Excel timesheet import',
        auth.uid(), v_actor, now(), now()
    )
    on conflict (user_id, work_date) do update set
        user_name_snapshot        = excluded.user_name_snapshot,
        raw_minutes_in_shift      = excluded.raw_minutes_in_shift,
        paid_minutes              = excluded.paid_minutes,
        daily_regular_minutes     = excluded.daily_regular_minutes,
        final_regular_minutes     = excluded.final_regular_minutes,
        daily_ot_minutes          = excluded.daily_ot_minutes,
        final_ot_minutes          = excluded.final_ot_minutes,
        hourly_rate_usd           = excluded.hourly_rate_usd,
        estimated_regular_pay_usd = excluded.estimated_regular_pay_usd,
        estimated_ot_pay_usd      = excluded.estimated_ot_pay_usd,
        estimated_gross_usd       = excluded.estimated_gross_usd,
        edited_by_id              = excluded.edited_by_id,
        edited_by_name            = excluded.edited_by_name,
        edit_reason               = excluded.edit_reason,
        approved_by_id            = excluded.approved_by_id,
        approved_by_name          = excluded.approved_by_name,
        approved_at               = excluded.approved_at,
        updated_at                = now()
    where public.timesheet_lines.locked = false;  -- never overwrite a locked (paid) line

    return jsonb_build_object('ok', true, 'email', p_email, 'name', v_name,
        'work_date', p_work_date, 'rate', v_rate, 'gross', v_gross,
        'regular_hours', coalesce(p_regular_hours,0), 'ot_hours', coalesce(p_ot_hours,0));
end
$imp$;

revoke all on function public.fn_import_timesheet_line(text,date,numeric,numeric,numeric) from public;
grant execute on function public.fn_import_timesheet_line(text,date,numeric,numeric,numeric) to authenticated;

commit;
do $s$ begin raise notice 'Migration 145 OK - fn_import_timesheet_line ready.'; end$s$;
-- END migration 145
