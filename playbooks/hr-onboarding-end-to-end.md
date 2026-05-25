---
slug: hr-onboarding-end-to-end
title: Onboard a new staff member end-to-end (offer → first day)
project: LYMX Power
role: admin
prereqs:
  - signed_in_as_admin
  - candidate_has_agreed_verbally
  - candidate_has_personal_email
duration_min: 25
difficulty: medium
last_verified: 2026-05-25
last_revised: 2026-05-25 (Step 4 Manage button; Step 5 home-address model; Step 6 optional; sub-role enum)
related:
  - partner-email-setup
  - admin-handle-feedback
---

# Onboard a new staff member end-to-end

This is the full sequence for adding someone (Dave the developer, Rachel the concierge, future hires) to LYMX as staff. By the end of this playbook the new person has a signed offer, a personnel file, the right admin role, their home address set for the clock-in geofence, their handbook acknowledged, their schedule set, and a calendar kickoff with their manager. The whole sequence takes about 25 minutes per person.

## Quick context — what "staff" means in LYMX

LYMX has three customer-facing roles (customer / business / partner) and one internal role: **staff**. Staff are the people who help run LYMX itself — developers, customer concierges, HR, finance. Staff is a separate row in `staff_roles` from any customer/partner row the person also has. The same person can be a staff member AND a customer AND a partner — that's normal — but the staff row is what unlocks the admin tools and the company `@getlymx.com` email.

There are six staff sub-roles in the `+ Add staff member` dropdown (per `admin-staff.html`). Each unlocks different admin tools:
- **admin** — full access to everything (Kenny, Helen)
- **tech** — bug verification + fixes, engineering tools (Dave)
- **support** — tickets, feedback inbox, customer chat (Rachel — partner concierge work fits here)
- **marketing** — proposes promo + content changes
- **finance** — sees billing, marks invoices paid
- **observer** — read-only access to admin pages

A separate `target_role` enum on the *offer letter* (Engineering / HR / CFO / Compliance / Accounting / Admin-onsite / Marketing / Customer support / Staff-generic) feeds onboarding-task templates and is set at Step 1. The two enums are independent — the staff-roles `role` value above is what gates which admin pages they see day-to-day.

Helen sets both at the appropriate steps below.

## What you'll need

- The new person's full legal name (as it should appear on their offer letter)
- Their personal email address (for the offer + welcome)
- Their sub-role (admin / tech / support / marketing / finance / observer — see intro for what each unlocks)
- A 25-minute block of focused time
- The candidate available on Slack/text to confirm they got the offer and accept

## What success looks like

When you finish this playbook, the new staff member can:
1. Sign in at `getlymx.com/login.html` with their personal email
2. See the admin sidebar (their sub-role's pages only)
3. Send email from `<theirname>@getlymx.com` (separate setup, see related playbook)
4. Find their schedule, policies, and personnel file in the admin portal
5. Has a kickoff meeting on the calendar with you within 7 days

You'll see them appear in `admin-personnel-records.html` with status **Active**.

## Steps

### Step 1 — Generate the offer letter

**Where:** `/admin-generate-offer.html`
**Do:** Click `📄 Generate offer` at the top right of `admin-hiring.html`, OR navigate directly. Fill in:
- Candidate's full legal name
- Role title (e.g. "Senior Frontend Developer", "Partner Concierge")
- Start date (typically next Monday)
- Base compensation (annual salary or hourly rate)
- Equity / bonus structure (if any — pulls from the active Benefits Policy)

Click `📄 Generate & save offer`.
**Element:** `#genBtn`
**Expect:** A PDF previews on the right side of the screen. The offer letter is also saved to the candidate's offer row in the database. Send the PDF to the candidate by email or share the auto-generated signing link.
**If you see "Could not save offer":** double-check every field is filled. Empty fields (especially compensation) silently fail validation.

### Step 2 — Wait for accept, handle counter-offers if any

**Where:** `/admin-counter-offer-queue.html`
**Do:** When the candidate replies with either an acceptance or a counter, you'll see their offer move into this queue.
- If they accepted: click `Mark accepted` on their card and move to Step 3.
- If they countered: click `Open counter` to see what they asked for, generate a revised offer (back to Step 1), or `Decline` the counter.
**Expect:** Once accepted, the offer row flips to status `accepted` and the candidate's email shows on the personnel-records page in Step 3.
**If the candidate is taking forever to reply:** that's normal. The offer stays in the queue indefinitely. Nudge them by personal text — the playbook doesn't auto-remind.

### Step 3 — Add them as staff with the right sub-role

**Where:** `/admin-staff.html`
**Do:** Click `+ Add staff member` at the top right. In the dialog:
1. Email: paste their personal email exactly as they used it to accept the offer.
2. Role: pick the sub-role from the dropdown. For Dave (developer): `tech`. For Rachel (concierge): `support`. (Full enum: marketing / support / tech / finance / observer / admin — see intro for what each unlocks.)
3. Click `Add staff`.
**Element:** `#addStaffBtn`
**Expect:** Their row appears in the Staff table with the role chip and "Active" status. A row is also inserted into `staff_roles` so role-gated admin pages start letting them in.
**If you see "Email not found":** they haven't signed up yet. Have them sign up at `getlymx.com/login.html` with that exact email first, then come back to Step 3 — the email-to-user-id lookup is the gating step.

### Step 4 — Open their personnel file + flip them onto payroll

**Where:** `/admin-personnel-records.html` → click their row → opens `/admin-personnel-file.html?id=<uuid>`
**Do:**
1. From the records list, click the **Active** chip, find the new person, click their name to open their file.
2. In the file header, click the **⚙ Manage** button (top-right of header).
3. In the Manage dialog: tick **On payroll** (this is the critical flag — without it, the staff member's "My Work → Clock In / My Schedule / My Time-off" sidebar never appears). Pick **Classification** (`W-2 full-time` for salaried staff, `W-2 part-time` for hourly, `1099 contractor` for contract). Set **Employment status** to **Active**. Tick **Clock-in exempt** only for salaried staff who don't punch a clock.
4. Click **Save**. The page reloads and the header now reads "Payroll ✓".
**Element:** `#manageBtn` opens the dialog; `#mngOnPayroll` is the toggle that matters.
**Expect:** After saving, refresh and the header chips show "Hired <date>", "Payroll ✓", and the classification chip. The staff member's next sign-in will show the "My Work" sidebar section.
**If the Manage button does nothing:** the page is stale (hard-refresh). If after refresh it still does nothing, file a feedback ticket — the wiring shipped 2026-05-25.
**Why this matters:** The "Payroll ✓" flag is what gates the Clock In / My Schedule / My Time-off sidebar entries via `lymx-sidebar.js:515`. The sidebar query is `staff_profiles?user_id=eq.<uid>&is_on_payroll=eq.true`. No on-payroll flag = no Clock In ever, no matter what other steps you complete.

### Step 5 — Set their HOME address for the clock-in geofence

**Where:** `/admin-staff-locations.html` (page title: "Staff Locations & Remote Clock-in")
**Do:** Every active staff member shows as one row in the table. For each new hire:
1. Type their home address in the **Home address** field.
2. Click **Lookup** — that populates the **Latitude** and **Longitude** columns via geocoding.
3. Leave **Geofence radius** at the default (200 metres, about one city block) unless they need a bigger zone.
4. Tick **Remote allowed** ONLY if their job requires punching in from outside their home (sales reps visiting partners, traveling concierge work). Leave unchecked for in-home / office-only roles — that enforces a strict geofence.
5. Click **Save** on their row.
**Expect:** Their row turns green-tinted, the Lat/Long fields stay populated, and the "Remote allowed" chip switches between "strict" and "allowed" accordingly.
**If you see "Lookup failed":** the address didn't geocode (likely a typo or apartment-only address). Type the building street address instead.
**Why home, not office:** LYMX staff mostly work remotely. The geofence enforces that punches come from where they actually work. If they're stationed at a specific Partner business, that's a separate Partner-side flow (the Partner sets their own clock-in addresses).

### Step 6 — (Optional) Approve any one-off remote-day requests

**Where:** `/admin-clock-in-permissions.html`
**Do:** This page is a REVIEW QUEUE — it doesn't proactively grant anything. Skip during onboarding. Come back here when an existing staff member submits a request from their own sidebar (`My Work → Remote Address` for ongoing, or `Single-day exception` for a one-off).
**For the staff member's first day:** Step 5's home-address geofence is enough. No queue entry needed.
**When a request DOES land here:** the row shows the staff name, requested address, reason, and date. Click **Approve** to set the granted geofence (lat/lng/radius) and a valid window. Click **Deny** with a note if their reason doesn't justify off-site work. Staff are emailed automatically.
**Why this is optional:** Migration 090 (2026-05-25) added admin-direct INSERT on `clock_in_permissions`, so technically you can also grant a permission via the SQL editor or REST. There's no admin-initiated grant UI yet — Step 5 covers 90% of the need.

### Step 7 — Bulk-assign policies they need to acknowledge

**Where:** `/admin-bulk-policy-assign.html`
**Do:** In the left column, tick every policy a new staff member needs:
- Employee handbook
- Code of conduct
- Confidentiality / NDA
- IT acceptable use
- Time-tracking & PTO policy
- (Any role-specific addenda — e.g. dev gets the "secure coding standards" policy)

In the right column, tick the new staff member's name. Click `Assign →`.
**Element:** `#assignBtn`
**Expect:** The button changes to `Assigned ✓` and a toast confirms how many policy-acknowledgment rows were created. The staff member will see them in their personnel file the next time they sign in, with an "Acknowledge" button next to each.
**If you see "Already assigned":** Bulk-assign skips cross-pairs that already exist. That's fine — it means no duplicate row was created.

### Step 8 — Schedule the kickoff meeting

**Where:** `/admin-onboarding-calendar.html`
**Do:** Copy the booking URL at the top of the page. In your favorite messaging app, send it to the new staff member with a one-line note like "Pick any 30-minute slot in the next 7 days that works for you — that's our kickoff."
**Element:** `#copyBtn`
**Expect:** When they pick a slot, the booking appears in `admin-bookings.html` and a confirmation email goes to both of you. The slot also blocks out on the public calendar.
**If they say no slots show:** double-check your availability windows. Open the `+ Add window` button at the bottom of the page and add a Mon-Fri 9–12 / 2–5 window if it's empty.

### Step 9 — Send them the welcome with their `@getlymx.com` email

**Where:** behind the scenes — happens automatically.
**Do:** Within a few minutes of Step 3 (adding them as staff), the system provisions `<theirname>@getlymx.com` and sends them a welcome email at their personal address. You can verify this fired by checking `/admin-email-events.html` for a `staff_welcome_email_sent` event with their email.
**Expect:** They get an email with subject starting with "Welcome to LYMX — your work email is ready" and a card showing their SMTP credentials.
**If the welcome email didn't arrive within 5 minutes:** open `/admin-email-events.html`, find their attempt, and re-trigger with the `Re-send welcome` button. Common reasons: their personal inbox bounced (typo in Step 3) or Cloudflare destination verify is still pending (covered in the partner-email-setup playbook).

### Step 10 — Walk them through their first sign-in

**Where:** Live, on a call (Slack / Daily / phone).
**Do:** When you meet for the kickoff in Step 8:
1. Have them sign in at `getlymx.com/login.html` while you watch.
2. Confirm the admin sidebar appears with the pages their sub-role allows.
3. Walk them through the **partner-email-setup playbook** so they can send from `@getlymx.com`.
4. Show them their personnel file — they should acknowledge each policy from Step 7 during the meeting.
5. Show them `admin-tech-support.html` so they know where to file tickets.
**Expect:** By end of kickoff: they've signed in, sent a test email from their `@getlymx.com` address, acknowledged every policy, and know where the help inbox is.
**If anything breaks during the live sign-in:** file the bug yourself from `/admin-tech-support.html` while you're both watching — fastest way to fix the gap before the next hire.

## Common errors

| Error you see | What's happening | How to fix |
|---|---|---|
| Step 3: "Email not found" when adding staff | The candidate hasn't signed up to LYMX yet — there's no `auth.users` row to attach a staff role to. | Have them go to `getlymx.com/login.html` and sign up with the same email that's on their offer. They'll get a confirmation email; once they verify, retry Step 3. |
| Step 4: Personnel file is missing after adding as staff | The trigger that auto-creates personnel files from accepted offers didn't fire, OR you skipped Step 1 and added them directly. | In `/admin-personnel-records.html` click `+ Add staff member` manually. Fill in the offer details that would have come from Step 1. |
| Step 5: "No businesses found" in the location picker | Their staff record exists but the location-picker reads businesses they have a customer or partner row tied to. | Confirm Step 3 succeeded (row appears in `admin-staff.html` table). If the new person is purely internal staff with no customer/partner role, all LYMX businesses should show. If only a partial list shows, the Drive-mirror copy of `admin-staff-locations.html` may be loading — hard-refresh. |
| Step 7: "Already assigned" toast for every policy | This person already had policies assigned from a previous onboarding attempt. | Safe to ignore — the bulk-assign tool skips duplicates by design. Open their personnel file to confirm the policy list looks right. |
| Step 9: Welcome email never arrives | (a) typo in the email address at Step 3, or (b) Cloudflare destination not yet verified for their personal inbox, or (c) SES credential rotation in flight. | Open `/admin-email-events.html`, search by their email, check the `error` column. If it says "destination not verified": ask them to find the Cloudflare verification email in their inbox/spam and click it, then re-send. If it says "auth error": ping Kenny — SES credentials may need rotation. |
| Step 10: Admin sidebar is empty after sign-in | Their staff row exists but `lymx-sidebar.js` cached an old role lookup. | Have them sign out, clear site data for `getlymx.com` in Chrome settings, then sign back in. |

## Reference / under the hood

This section is for technical readers. Helen and other HR-tier admins don't need to read it.

- **Tables touched** during this playbook, in order:
  - Step 1 → `offers` (insert), `offer_documents` (insert)
  - Step 2 → `offers` (update status), `offer_counters` (insert if applicable)
  - Step 3 → `staff_roles` (insert), `staff_profiles` (insert)
  - Step 4 → `personnel_files` view (read-only; populated by trigger on `staff_profiles`)
  - Step 5 → `staff_locations` (insert)
  - Step 6 → `clock_in_permissions` (insert)
  - Step 7 → `policy_assignments` (bulk insert; unique constraint on (`staff_user_id`, `policy_id`) prevents dupes)
  - Step 8 → `onboarding_bookings` (insert by booking link; managed by `book-onboarding-call` EF)
  - Step 9 → Edge Function `provision-staff-email` fires on `staff_roles` insert via trigger
  - Step 10 → no DB writes, manual sanity walkthrough
- **Edge Functions invoked:**
  - `generate-offer-letter` — renders PDF, stores in `storage/offer-letters/`
  - `provision-staff-email` — creates `@getlymx.com` alias, registers route with Cloudflare, sends welcome via Resend
  - `book-onboarding-call` — public booking endpoint, no auth needed
- **Migrations that created these tables:** 055–061 (HR module), 084–086 (staff role refinements). Master deploy runbook lives at `LYMX Backend\HR-MODULE-DEPLOY-RUNBOOK.md`.
- **Role-to-permission map** for the sub-roles in Step 3 is in `db/057_permissions_model.sql`, function `permission_template_for_staff_role()`. To grant a permission outside the template, use `/admin-manage-permissions.html` after Step 3.
- **Future automation:** Steps 5–9 should auto-fire from a single "Onboard this person" button once the in-app walkthrough engine ships. For now they're manual to give Helen visibility into every state change.

## Update history

- 2026-05-25 (revised) — Walked end-to-end against deployed pages. Fixed: (1) sub-role enum was wrong (admin/dev/concierge → marketing/support/tech/finance/observer/admin); (2) Step 4 now uses the `⚙ Manage` button that was wired in this revision; (3) Step 5 sets HOME address for geofence, not "business locations" (the actual page model); (4) Step 6 reframed as optional review queue; (5) Migration 090 unblocked the underlying RLS + auto-location-on-approval chain that prevented this playbook from being usable before today.
- 2026-05-25 — First version. Written for Helen Chen to onboard Dave (dev) and Rachel (concierge) as the first two non-founder staff. End-to-end manual walkthrough — automated single-button onboarding queued for the walkthrough-engine phase.
