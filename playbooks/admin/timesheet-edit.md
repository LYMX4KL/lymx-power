---
slug: admin-timesheet-edit
title: Backfill or adjust a staff member's timesheet line
project: LYMX Power
role: admin
prereqs:
  - admin_role_or_hr_or_cfo
  - staff_member_exists_in_v_team_roster
duration_min: 2
difficulty: easy
last_verified: 2026-05-27
related:
  - hr-onboarding-end-to-end
  - admin-clock-in-now
supersedes: null
---

# Backfill or adjust a staff member's timesheet line

When a staff member misses a clock-out (system bug, dead phone, geofence rejected them), or when payroll needs to retro-adjust a row (extra hours owed, missed-lunch premium, etc.), this is where you make the change. It writes to `timesheet_lines` (the daily payroll-bound summary), NOT to `clock_events` (raw punch history). Raw punches stay forensic; the edited line is what goes to payroll.

## When you use this

- **Missed clock-out:** Staff member ended their shift but forgot to hit Clock Out. Their `clock_events` row shows them still on the clock — but you know they left at 5pm. Backfill the `clock_out_at` + recompute paid minutes.
- **Phone died at lunch:** Clock-out for lunch happened, clock-in after lunch didn't. The system thinks they took a 4-hour break. Edit the row to set the right lunch span.
- **Retro premium-pay:** Manager confirms missed-lunch premium owed. Tick the `missed_lunch_flag` so payroll picks it up.
- **System glitch wiped a day:** The clock_events for that user/date never landed (RLS bug, geofence misconfigure, etc.). Backfill the line manually from their Slack confirmation or schedule.
- **Reverse an erroneous edit:** Click Edit on the affected row, fix the values back, write the new reason. The previous edit is preserved in the audit log (the `edited_*` columns + version history if `pgaudit` is on).

## How to find it

Admin sidebar → **HR & Payroll** → **✏️ Edit timesheet lines**.
Direct URL: `/admin-timesheet-edit.html`.

## What you see

**Filters** (top):
- Staff member dropdown (defaults to All staff)
- From date / To date (defaults to last 30 days)
- Show: All / Edited / Locked / Missed lunch / Zero paid minutes (likely missing)

**Summary strip** — six small cards counting Lines / Edited / Locked / Missed lunch / Zero paid / Est. gross total in the current filter.

**Table** — one row per `timesheet_lines` row in range. Columns: Date · Staff · In · Out · Paid hrs · Reg/OT · Pay · Flags · Actions.

Each row's **Edit** button opens the modal.

## How to edit an existing row

1. Find the row. If you don't see it: widen the date range, or check the Zero-paid filter.
2. Click **Edit**.
3. Fix any of: clock_in_at, clock_out_at, paid minutes, lunch minutes, regular/OT minutes, hourly rate, missed_lunch_flag.
   - The clock_in/out fields are datetime-local — set them in your local timezone, the page converts to UTC on save.
   - Paid minutes auto-suggests as `(out − in) − lunch` when you change in/out/lunch. Override manually if needed.
4. **Edit reason is required.** Type what was wrong and what you changed. Examples:
   - "Helen missed clock-out at lunch return; restored 12:00 → 17:00 from her Slack confirmation."
   - "Schedule said 6am start but clock-in misfired; backfilled at 6:00 from manager."
5. Leave **Lock this row** ticked (default). Locked rows are skipped by the auto-recompute job, so your manual values survive the next nightly sync.
6. Click **Save**.

**What gets stamped automatically:**
- `edited_by_id` = your auth.users.id
- `edited_by_name` = your email
- `edited_at` = now()
- `locked` = whatever you set (default true)
- `updated_at` = now() (via trigger)

## How to backfill a missing day

1. Click **+ Backfill a day** in the top-right of the page.
2. Pick the staff member from the dropdown.
3. Pick the work date.
4. Fill in clock_in_at, clock_out_at, paid minutes, lunch minutes — at minimum the in/out times.
5. Type your edit reason (required).
6. Save.

**If a line already exists for that staff + date:** the page uses `?on_conflict=user_id,work_date` with `resolution=merge-duplicates`, so the backfill becomes an upsert and overrides the existing values. The unique constraint on `(user_id, work_date)` guarantees one row per day.

## Field reference

| Field | DB column | What it drives |
|---|---|---|
| Clock in | `clock_in_at` (timestamptz) | Display only on this page; the canonical truth is `clock_events` rows. |
| Clock out | `clock_out_at` (timestamptz) | Same. |
| Paid minutes | `paid_minutes` (integer) | The number that goes to payroll. Not auto-recomputed once `locked=true`. |
| Qualifying lunch | `qualifying_lunch_minutes` (integer) | Subtracted from raw span to compute paid time. |
| Daily regular | `final_regular_minutes` (integer) | Regular-rate minutes for the day. |
| Daily OT | `final_ot_minutes` (integer) | Overtime minutes (>8h/day or >40h/week). |
| Hourly rate | `hourly_rate_usd` (numeric) | Override the staff_roles rate for this one day if needed. |
| Missed lunch flag | `missed_lunch_flag` (boolean) | Triggers California-style missed-lunch premium pay downstream. |
| Edit reason | `edit_reason` (text) | Required. Audit trail. |
| Lock | `locked` (boolean) | When true, recompute jobs skip this row. |

## Permission model

The page is gated by `<body data-role-required="admin">` + `lymx-role-gate.js`. The RLS policy `tsl_hr_write` (migration 084 line 384) lets the following insert/update/delete on `timesheet_lines`:

- `am_i_admin()` = true
- `am_i_hr_or_admin()` = true
- `am_i_cfo()` = true

If accounting needs access but is none of those: add `is_accounting = true` on their staff_roles row, or grant them `admin` sub-role.

## Common errors

| What you see | Why | Fix |
|---|---|---|
| "Save failed: 23514 …check constraint…" | A minutes value is negative or out of range. | Fix the offending field; minutes must be >= 0. |
| "Save failed: 23505 …unique constraint…" | A row for this staff + work_date already exists, and the upsert collision header was missing. | Refresh the page (deploy may be stale) and retry. Or click Edit on the existing row instead. |
| "Save failed: 42501 permission denied" | Your account isn't admin/HR/CFO. | Get an admin to flip your role. |
| Backfilled a day but it doesn't show on the next reload | Date range filter excludes that date. | Widen the From/To filters. |
| Edited a row, then the values reverted overnight | The row was not locked — the auto-recompute overwrote your edit. | Re-edit and tick Lock. |

## What this page does NOT do

- **Doesn't insert or modify `clock_events`** — raw punch history stays forensic. Use `/staff-clock-in.html` to insert a real punch (signed in as that staff member).
- **Doesn't trigger the recompute job manually** — that runs nightly. Your locked rows skip it.
- **Doesn't generate paystubs** — payroll-run is in `/admin-payroll-reconciliation.html`.
- **Doesn't show approvals** — manager-approve workflow uses `approved_by_id` / `approved_at`. Add that flow when an approval UI ships (not in v1).

## Data sources

- **`timesheet_lines`** (table, migration 084 line 332) — the canonical edit target. One row per `(user_id, work_date)`.
- **`v_team_roster`** (view, migration 025) — for the staff dropdown.
- **`staff_profiles`** (table, migration 055) — for display_name.

## Reference

Built 2026-05-27 in response to Kenny's "accounting/admin needs an edit function for backfill/adjust" request. Ships alongside admin-clock-in-now.html (the live view) and admin-timesheets.html (the raw events log) — together those three pages cover read, edit, and historical inspection.
