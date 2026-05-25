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
related:
  - partner-email-setup
  - admin-handle-feedback
---

# Onboard a new staff member end-to-end

This is the full sequence for adding someone (Dave the developer, Rachel the concierge, future hires) to LYMX as staff. By the end of this playbook the new person has a signed offer, a personnel file, the right admin role, their business locations assigned, their handbook acknowledged, their schedule set, and a calendar kickoff with their manager. The whole sequence takes about 25 minutes per person.

## Quick context — what "staff" means in LYMX

LYMX has three customer-facing roles (customer / business / partner) and one internal role: **staff**. Staff are the people who help run LYMX itself — developers, customer concierges, HR, finance. Staff is a separate row in `staff_roles` from any customer/partner row the person also has. The same person can be a staff member AND a customer AND a partner — that's normal — but the staff row is what unlocks the admin tools and the company `@getlymx.com` email.

There are several staff sub-roles, each with different admin tool access:
- **admin** — full access to everything (Kenny, Helen)
- **dev** — engineering tools, deploy access (Dave)
- **concierge** — partner onboarding tools, booking calendar (Rachel)
- **hr** — personnel files, write-ups, reviews
- **support** — tickets, feedback inbox, customer chat
- **finance** — payouts, commissions, ledger

Helen sets the sub-role at Step 3 below.

## What you'll need

- The new person's full legal name (as it should appear on their offer letter)
- Their personal email address (for the offer + welcome)
- Their sub-role (admin / dev / concierge / hr / support / finance)
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
2. Role: pick the sub-role from the dropdown (admin / dev / concierge / hr / support / finance).
3. Click `Add staff`.
**Element:** `#addStaffBtn`
**Expect:** Their row appears in the Staff table with the role chip and "Active" status. A row is also inserted into `staff_roles` so role-gated admin pages start letting them in.
**If you see "Email not found":** they haven't signed up yet. Have them sign up at `getlymx.com/login.html` with that exact email first, then come back to Step 3 — the email-to-user-id lookup is the gating step.

### Step 4 — Verify their personnel file was auto-created

**Where:** `/admin-personnel-records.html`
**Do:** Open the page and click the **Active** chip. Find the new person's row. Click their name to open the personnel file.
**Element:** `.chip[data-f="active"]`
**Expect:** You see their personnel file with sections: Profile, Compensation, Policies, Write-ups, Reviews, Time off. The Profile section has their name, role, start date, and contact info. Compensation shows the offer numbers from Step 1.
**If their file is missing:** the trigger that creates personnel files from accepted offers may not have fired. Go to `admin-personnel-records.html` and click `+ Add staff member` manually, or ping Kenny.

### Step 5 — Assign their business locations

**Where:** `/admin-staff-locations.html`
**Do:** Find the new staff member in the dropdown at the top. For each LYMX business they need access to (for Dave: probably all of them so he can debug; for Rachel: the concierge office plus any specific partner she's supporting), tick the location and click `Save`.
**Expect:** A blue confirmation banner reads `Locations saved for <name>.` Their row in the table reflects the assigned businesses.
**If you see "No businesses found":** their `user_id` didn't resolve. Re-check Step 3 — the email must match a row in `customers` or `partners` for businesses to be selectable.

### Step 6 — Set their clock-in permission (if hourly)

**Where:** `/admin-clock-in-permissions.html`
**Do:** Skip this step for salaried staff (most LYMX hires).
For hourly staff: find their row and tick the boxes for the locations where they can clock in. Click `Save`.
**Expect:** Their row shows ✓ next to the allowed locations.
**If you see "Allow self clock-in" toggle:** leave it OFF for new hires until they've done their first kickoff meeting — prevents anyone from clocking in before training is complete.

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

- 2026-05-25 — First version. Written for Helen Chen to onboard Dave (dev) and Rachel (concierge) as the first two non-founder staff. End-to-end manual walkthrough — automated single-button onboarding queued for the walkthrough-engine phase.
