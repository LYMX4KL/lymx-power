# LYMX HR Module — Deploy Runbook

Status as of **2026-05-19**

## What you have, all built

### 7 migrations — all 5 of these RAN already, 2 left to run:

| # | File | Status |
|---|------|--------|
| 055 | `055_hr_foundation.sql` — roles + staff_profiles + benefits_policy | ✓ ran |
| 056 | `056_hr_hiring_lifecycle.sql` — jobs / applications / offers | ✓ ran |
| 057 | `057_hr_policy_documents.sql` — policies + e-sign | ✓ ran |
| 058 | `058_hr_personnel_records.sql` — write-ups + reviews | ✓ ran |
| 059 | `059_hr_termination_inventory.sql` — terminations + inventory | ✓ ran |
| 060 | `060_hr_admin_user_lookup.sql` — admin_list_user_emails RPC | **pending** |
| 061 | `061_hr_cron_schedules.sql` — pg_cron for the 4 cron EFs | **pending** |

### 11 HTML pages — built on disk, NOT yet pushed to GitHub:

`C:\Users\Kenny\Desktop\Gemini\LYMX Power\`

- `admin-personnel-records.html` — roster hub
- `admin-personnel-file.html` — per-staff 7-tab file
- `my-personnel-file.html` — staff self-service
- `admin-issue-write-up.html` — defensible write-up form
- `admin-bulk-policy-assign.html` — N×M policy assigner
- `admin-outstanding-property.html` — post-termination queue
- `admin-inventory.html` — inventory master
- `admin-inventory-new.html` — bulk-add inventory
- `admin-termination.html` — full 7-stage workflow
- `admin-review.html` — 3-mode review form
- `admin-generate-offer.html` — offer letter generator

### 8 Edge Functions — built on disk, NOT yet deployed:

`C:\Users\Kenny\Desktop\Gemini\LYMX Backend\functions\`

- `generate-offer-letter` — renders offer letter from current benefits policy
- `auto-close-clock-events` — cron 07:00 UTC daily
- `enforce-lunch-policy` — cron 06:30 UTC daily
- `end-of-shift-reminder` — cron every 30 min
- `property-aging-cron` — cron Monday 14:00 UTC
- `notify-ot-request` — emails HR/admin on OT submission
- `revoke-staff-access` — ban auth user + flip is_active=false
- `reactivate-staff` — clear ban + restore is_active=true

---

## Deploy steps — do these in order

> **Note (2026-05-19):** Earlier drafts of this runbook had a CRON_SECRET step. We discovered Supabase blocks `alter database postgres set app.settings.*` with permission error 42501, so we pivoted to migration 050's pattern — pg_cron now uses Supabase's auto-populated `app.settings.service_role_key` and the EFs trust the service-role JWT. **You can ignore the `CRON_SECRET` secret that's already in Supabase — it's unused.** (Or delete it for cleanliness.)

### Step 1 — Run migration 060

Open SQL editor → paste contents of `db/060_hr_admin_user_lookup.sql` from GitHub raw → Run.

### Step 2 — Push HR pages to GitHub

Drag-and-drop these 11 files from `C:\Users\Kenny\Desktop\Gemini\LYMX Power\` onto the GitHub repo root via the GitHub web UI:

1. admin-personnel-records.html
2. admin-personnel-file.html
3. my-personnel-file.html
4. admin-issue-write-up.html
5. admin-bulk-policy-assign.html
6. admin-outstanding-property.html
7. admin-inventory.html
8. admin-inventory-new.html
9. admin-termination.html
10. admin-review.html
11. admin-generate-offer.html

Commit message:

```
HR module — 11 admin/staff pages (personnel records, write-ups, reviews, termination, inventory, offers)
```

### Step 3 — Deploy 8 Edge Functions

For each function below, in Supabase Dashboard → Edge Functions → click the function name (or "Deploy new function" if it doesn't exist yet) → paste the `index.ts` contents from `LYMX Backend/functions/<name>/index.ts` → Deploy.

In rough order of priority:

1. `generate-offer-letter` (admin-generate-offer.html needs it)
2. `notify-ot-request` (my-time-off.html will call it)
3. `revoke-staff-access` (admin-termination.html calls it)
4. `reactivate-staff` (admin-personnel-file.html calls it for rehires)
5. `auto-close-clock-events`
6. `enforce-lunch-policy`
7. `end-of-shift-reminder`
8. `property-aging-cron`

### Step 4 — Run migration 061 (cron schedules)

Open SQL editor → paste contents of `db/061_hr_cron_schedules.sql` from GitHub raw → Run.

You should see at the bottom:

```
status                  | migration 061 applied
hr_jobs_scheduled       | 4
job_names               | {lymx_hr_auto_close_clock, lymx_hr_end_of_shift_reminder, lymx_hr_enforce_lunch, lymx_hr_property_aging_weekly}
```

### Step 5 — Verify Netlify deploy went through

`getlymx.com/admin-personnel-records.html` should load (use admin-deploy verify checklist).

### Step 6 — Smoke test

1. Open `getlymx.com/admin-personnel-records.html` while logged in as Kenny.
2. Click any staff name → opens admin-personnel-file.html with 7 tabs.
3. Try **+ Issue write-up** → submits, lands in write_ups table.
4. Try **Assign policies (bulk)** → N×M selector, creates rows.
5. Open `admin-generate-offer.html` → pick an applicant → Generate → preview iframe renders the offer letter.
6. Open `admin-inventory.html` → **+ Add inventory** → bulk-add 3 keys with prefix `KEY-` → see 3 rows with KEY-001, KEY-002, KEY-003.

---

## Push to GitHub — also push these from LYMX Backend

```
db/060_hr_admin_user_lookup.sql
db/061_hr_cron_schedules.sql
functions/generate-offer-letter/index.ts
functions/auto-close-clock-events/index.ts
functions/enforce-lunch-policy/index.ts
functions/end-of-shift-reminder/index.ts
functions/property-aging-cron/index.ts
functions/notify-ot-request/index.ts
functions/revoke-staff-access/index.ts
functions/reactivate-staff/index.ts
```

Commit message for the backend repo:

```
HR module backend — 2 migrations (060 user-lookup, 061 cron) + 8 Edge Functions (offer letter, clock auto-close, lunch enforce, shift reminder, property aging, OT notify, revoke/reactivate)
```

---

## Notes for tomorrow

- `enforce-lunch-policy` depends on `system_issue_missed_lunch_writeup` (RPC defined in migration 058 — already live).
- `notify-ot-request` requires an OT-request table to actually persist requests. For now it just emails HR + opens a conversation thread. **TODO**: add `overtime_requests` table in a future migration if you want a persisted record + approve/deny RPC.
- `revoke-staff-access` uses `ban_duration: "876600h"` (100 years). If Supabase's auth admin API rejects that, the EF falls back to a `user_metadata.lymx_access_revoked` flag — safe but the user could still log in. **Verify this works** with the first real termination by trying to log in as the terminated user immediately after.
- The 30-minute `end-of-shift-reminder` cron may rack up pg_net calls — about 48/day. If quota becomes a concern, narrow the cron to `*/30 14-2 * * *` (PT shift window roughly).
