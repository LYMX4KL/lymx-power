---
slug: admin-clock-in-now
title: Check who is currently clocked in
project: LYMX Power
role: admin
prereqs:
  - admin_role
  - staff_have_clock_in_locations_set (Step 5 of hr-onboarding-end-to-end)
duration_min: 1
difficulty: easy
last_verified: 2026-05-27
related:
  - hr-onboarding-end-to-end
supersedes: null
---

# Check who is currently clocked in

A live view of every staff member's most-recent clock event, bucketed into **Currently clocked in / On break / Clocked out / Never clocked in**. Auto-refreshes every 30 seconds. This is the page Helen opens when she wants to know who's actually on the floor right now without paging through timesheets or the team roster.

## When you open this

- During the workday — quick "who's here?" check before pinging someone on Slack.
- When a staff member says "I clocked in but it didn't work" — confirm whether their punch landed.
- After an outage — confirm everyone who claimed to be on shift actually is.
- For payroll edge cases — see who's been at lunch unusually long (still in "on break" past an hour).

## What you see

**Summary strip** — five cards at the top:
- **Clocked in** (green) — staff whose last event is `in`
- **On break** (amber) — last event is `break_start`
- **Clocked out** (grey) — last event is `out` or `break_end`
- **Never clocked in** (grey) — staff with no `clock_events` rows at all
- **Total staff** — every row in `v_team_roster`

**Group cards** — one card per non-empty bucket, sorted with the most-recent activity at the top. Each row shows:
- Avatar (initials), name, email, job title, role
- The event label ("Clocked in" / "Started break" / "Ended break" / "Clocked out")
- How long ago the event fired (e.g. "12m ago")
- For events with GPS data: geofence pass/fail, distance from anchor, "remote allowed" flag if Step 6 of hr-onboarding granted a single-day exception

## How to use it

**Refresh manually:** click the `↻ Refresh` button in the top-right of the page header. The "last refreshed at" timestamp updates beneath the button.

**Auto-refresh:** the page polls every 30 seconds automatically. Leave the tab open during the workday for a always-current view.

**Diagnose a missing punch:**
1. Find the staff member in the "Never clocked in" or "Clocked out" bucket.
2. Read the event label + timestamp on their row. If it's days old, they likely tried to punch in but the geofence rejected them — open `/admin-clock-in-permissions.html` to see if they submitted a one-off remote request.
3. If their row shows a recent `out` event with `⚠ outside geofence`, the punch failed the geofence — Step 5 of hr-onboarding needs revisiting (their home address is wrong, or their work location is different from their home anchor).

**See where someone is right now:**
- Click their row (currently visual-only; future iteration will deep-link to their personnel file).
- The `Xm` distance number is their distance from their home anchor at the time of their last punch.

## Data sources

- **`v_team_roster`** (view, migration 025) — the canonical staff list. user_id + email + job_title + role + has_anchor + last_clock_in.
- **`staff_profiles`** (table, migration 055) — pulls `display_name` so the name in the row isn't just the email local-part.
- **`clock_events`** (table, migration 025) — the actual punch events. RLS policy `clock_admin_all` (line 125-127 of migration 025) lets admins SELECT every row regardless of `user_id`.

## What this page does NOT do

- **Doesn't punch in/out for someone else.** The page is read-only. Use `/staff-clock-in.html` (signed in as that staff member) to punch.
- **Doesn't show historical timesheet data.** That's `/admin-timesheets.html`.
- **Doesn't grant remote permissions.** That's `/admin-clock-in-permissions.html`.

## Troubleshooting

| What you see | What it means | How to fix |
|---|---|---|
| "Load failed: 401" or "403" | Your auth session expired, or you're not signed in as admin. | Refresh and sign back in. Confirm `am_i_admin()` returns true for your account (`/admin-staff.html` should show your row with role=admin). |
| Page shows the summary cards but every bucket is empty | The staff roster (`v_team_roster`) is empty — no staff have been added yet. | Add a staff member via `/admin-staff.html` (or complete hr-onboarding-end-to-end Step 3). |
| "Never clocked in" is way larger than expected | Either staff don't actually use Clock In (they're salaried/clock-exempt) or migration 025 was never seeded. | Open `/admin-personnel-file.html?id=<uuid>` for one of them — if **Clock-in exempt** is ticked, that's intentional and they belong in this bucket forever. |
| Auto-refresh stopped | Browser tab was throttled (background). | Click `↻ Refresh` once to wake it up. |
