---
slug: pay-hourly-staff-today
title: Pay hourly staff today (onboard → Excel timesheet → payroll)
project: LYMX Power
role: admin
prereqs:
  - signed_in_as_admin
  - you_have_each_person_email_and_hours
duration_min: 20
difficulty: easy
last_revised: 2026-05-30
related:
  - hr-onboarding-end-to-end
  - commission-engine-verification
---

# Pay hourly staff today — the short path

**Helen, start here.** This is the quickest route to paying Dave and Rachel for hours they've already worked, even though clock-in isn't set up for them yet. You'll (1) make sure each person is a staff member on payroll, (2) load their hours from your Excel sheet, and (3) run payroll. About 20 minutes.

You can open every page below from the **left sidebar → Admin → HR & Payroll** section once you're signed in at `getlymx.com/login.html`. If you ever feel lost, this Playbooks page is always at `getlymx.com/playbooks.html`.

## Phase 1 — Make sure each person is staff + on payroll (5 min)

Skip any step that's already done.

1. **Add them as staff** — open **Staff Roles** (`/admin-staff.html`) → `+ Add staff member`. Enter their email (the one they sign in with) and pick a role: Dave = **tech**, Rachel = **support**. Click **Add staff**.
   - "Email not found"? They need to sign up once at `getlymx.com/login.html` with that exact email first, then retry.
2. **Flip them onto payroll** — open **Personnel Records** (`/admin-personnel-records.html`) → click their name → **⚙ Manage** → tick **On payroll**, set **Classification** (W-2 part-time for hourly), set status **Active**, **Save**.

That's the minimum needed for payroll to count them. (The full onboarding — policies, clock-in location, kickoff — is in the *hr-onboarding-end-to-end* playbook and can be finished later.)

## Phase 2 — Load their hours from Excel (5 min)

Because nobody's clock-in is set up yet, enter the hours from your spreadsheet directly.

1. Open **Import Timesheet (Excel)** (`/admin-timesheet-import.html`).
2. Click **⬇ Download Excel template**. It has five columns: `email`, `work_date` (YYYY-MM-DD), `regular_hours`, `ot_hours`, `hourly_rate`.
3. Fill one row per person per day. Use the same email they sign in with. Leave `hourly_rate` blank to use the rate on their profile, or type it to override. Overtime is paid at 1.5×.
4. **Upload** your file. You'll see a preview with a green **ready** / red **skip** tag per row.
5. Click **Import valid rows**. Each row becomes a **pre-approved** timesheet line. Re-importing the same person + date safely overwrites — it never double-pays, and it won't touch a day that's already been locked/paid.

## Phase 3 — Run payroll and pay (5 min)

1. Open **Payroll Run** (`/admin-payroll-reconciliation.html`).
2. Pick (or **+ New period**) the pay period that covers those dates → **Load**. Dave and Rachel now show with their hours and gross pay.
3. Review the numbers. **Export CSV** for your bank / Gusto / ACH.
4. **Lock period** (no more edits), then **Mark paid out** once the money is sent. The period shows "Paid out ✓".

That's it — they're paid.

## Common errors

| What you see | Why | Fix |
|---|---|---|
| Import row says **skip** | Missing email, bad date, or 0 hours | Check the row in your Excel — email must be valid, date `YYYY-MM-DD`, hours > 0 |
| "no account found for this email" | That email has never signed in to LYMX | Have them sign up at `getlymx.com/login.html` with that email, then re-import |
| Payroll page shows them with **$0 / no rows** | Hours weren't imported for those dates, or the period dates don't cover them | Re-check the period start/end vs the `work_date`s you imported |
| Rate column shows "(profile)" but pay is $0 | Their profile has no hourly rate | Put the rate in the `hourly_rate` column of the Excel, or set it on their personnel file |
| Can't open the HR pages | Your account isn't admin / hr_admin | These pages are gated to HR. Confirm you're signed in as yourself (Helen) — you have full admin |

## Why Excel instead of clock-in (for now)

Clock-in needs each person added as staff, flipped **on payroll**, and given a home **clock-in location** for the geofence (see *hr-onboarding-end-to-end*, Steps 4–5). Until that's done they can't punch in — so this Excel path lets you pay for hours already worked today. Once everyone's clock-in is set up, their daily punches flow into the same Payroll Run automatically and you won't need the Excel import.
