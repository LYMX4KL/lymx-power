# Next-session runbook — Mirror InvestPro PM admin features for LYMX

> Kenny built a mature admin/feedback/broadcast workflow at InvestPro PM. This doc maps what to clone for LYMX. **Read this BEFORE starting next session** so we hit the ground running.

## Source files to study (in `Gemini/InvestPro PM/`)

| File | What it does | LYMX mirror |
|---|---|---|
| `db/020_feedback_system.sql` | Feedback table + RLS + triage states | ✅ Already built as `LYMX Backend/migrations/008_feedback.sql` |
| `db/072_bug_verifications.sql` | Bug verification workflow — fix gets verified by reporter | New: `migrations/009_bug_verifications.sql` |
| `docs/STANDARD-FEEDBACK-WORKFLOW.md` | The process: receive → triage → fix → verify → broadcast | Read this first; mirror process doc for LYMX |
| `netlify/functions/feedback-notify.js` | Sends email when feedback arrives | Edge Function `feedback-notify` |
| `netlify/functions/verify-bug.js` | Marks a bug as fixed; pings reporter to verify | Edge Function `verify-bug` |
| `netlify/functions/team-broadcast.js` | Send announcement to team / role | Edge Function `team-broadcast` |
| `netlify/functions/broadcast-bug-verifications.js` | When bug verified, broadcast that the fix is live | Edge Function `broadcast-bug-verifications` |
| `portal/admin/tech-support.html` | Admin inbox: cluster grid, severity rollup, drill-down | LYMX `admin-tech-support.html` |
| `portal/admin/broadcast.html` | Compose + send broadcasts | LYMX `admin-broadcast.html` |
| `portal/broker/feedback.html` | Broker-side feedback view | LYMX has it auto-injected on every page (lymx-feedback.js) ✅ |

## Build order (2-3 sessions, total ~10 hours)

### Session 1: admin dashboard core
1. Read `db/020_feedback_system.sql` from InvestPro to confirm schema parity
2. Build `LYMX Power/admin-tech-support.html` mirroring `portal/admin/tech-support.html`
   - 6 metric cards (Urgent / High / Bugs / Suggestions / Questions / Resolved 7d)
   - Cluster grid (one card per feature area, with new/in-progress/resolved counts)
   - Drill-down table when cluster clicked
3. Hard-gate access to `public.am_i_admin()` (admin via staff_roles) for v1
4. Wire DB queries via `LYMX.sb.from('feedback').select...`
5. Smoke test: submit fake feedback via the button, verify it appears in admin inbox

### Session 2: bug verification workflow
1. Read `docs/STANDARD-FEEDBACK-WORKFLOW.md`
2. Migration 009 — bug_verifications table:
   ```sql
   create table public.bug_verifications (
     id uuid primary key,
     feedback_id uuid references public.feedback(id),
     fix_commit_sha text,           -- which commit fixed it
     fix_summary text,              -- what was fixed
     verification_state text default 'pending',  -- pending/verified/regression
     verified_by uuid references auth.users(id),
     verified_at timestamptz,
     ...
   );
   ```
3. Build `verify-bug` Edge Function (admin marks fix → emails reporter → reporter clicks "Yes it's fixed")
4. Add to admin dashboard: "Mark fixed" button on resolved feedback rows

### Session 3: broadcast system
1. Migration 010 — broadcasts table (target_role, message, sent_at, dismissed_by[])
2. Build `team-broadcast` and `broadcast-bug-verifications` Edge Functions
3. Build `LYMX Power/admin-broadcast.html` (admin composes)
4. Add a top-banner component to `lymx-feedback.js` (or a new shared script) that fetches active broadcasts on page load and shows them with a Dismiss button
5. Smoke test: send a broadcast → verify it shows on every page → dismiss → verify it stays dismissed

## Tonight's state (2026-05-09 late evening) — what's already built

**Live in production (commits pushed):**
- All 13 QA bugs fixed
- Real Supabase Auth wiring (login + customer-dashboard + biz-dashboard)
- Partner Dashboard wired to real backend (Founding 25 status etc.)
- Show-password toggle on login
- SMTP setup card on rep-dashboard
- Partner signup form wired to backend (with `?ref=` attribution)
- Helen TestRun successfully signed up as Partner #2 — proves end-to-end

**Built tonight, waiting on Kenny to deploy:**
- `LYMX Backend/migrations/008_feedback.sql` — needs to be run in SQL editor
- `LYMX Backend/functions/feedback-submit/index.ts` — needs to be deployed via Edge Functions web UI
- `LYMX Power/lymx-feedback.js` — needs to be pushed to GitHub
- 230+ HTML files have been bulk-injected with `<script src="lymx-feedback.js">` — needs to be pushed (start with the ~13 highest-traffic pages tonight; rest next session)

**Two files are TRUNCATED on Desktop and need repair next session:**
- `partner-signup.html` (Desktop has 420 lines, should be ~520)
- `rep-dashboard.html` (Desktop has 569 lines, should be ~640)

These are the casualties of a Drive Desktop streaming bug. Production has the working versions. Repair option: `cd C:\Users\Kenny\Desktop\Gemini && git clone https://github.com/LYMX4KL/lymx-power.git lymx-power-repo` — that gives a clean local copy. Or download each file via GitHub web → Raw → Save As.

## Process: handling feedback as it comes in

Tonight, while we wait to build the admin dashboard, you can read incoming feedback directly via Supabase:

1. Open https://supabase.com/dashboard/project/apffootxzfwmtyjlnteo/editor
2. Click on `feedback` table in the sidebar
3. Sort by `created_at desc` to see newest first
4. Each row shows: type, priority, subject, message, page_url, user_email, status

Triage by changing `status` (new → in_progress → resolved) and adding `admin_notes`.

When you ship a fix, set `status='resolved'` and `resolved_at = now()`. The bug-verification flow (next session) will let you ping the reporter to confirm the fix.
