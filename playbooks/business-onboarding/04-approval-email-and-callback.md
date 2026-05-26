---
slug: business-onboarding-04-approval-email-and-callback
title: Approval email + the required 20-minute onboarding call
project: LYMX Power
role: admin
prereqs:
  - signed_in_as_admin
  - applicant_already_approved
duration_min: 5
difficulty: easy
last_verified: 2026-05-26
related:
  - business-onboarding/README
  - business-onboarding/03-approval
supersedes: null
---

# Approval email + the required 20-minute onboarding call

When you click **✓ Approve** on a pending application (see [[business-onboarding-03-approval]]), the system fires an email to the applicant that frames the next required step: a free 20-minute onboarding call. Module 3 of the biz-onboarding roadmap makes that call REQUIRED (not optional), personalizes the booking URL with their business slug so the host sees the biz context, and adds a nightly cron that re-emails approved-but-unbooked applicants on a tasteful 7-day cadence.

## What you'll need
- An admin account
- An applicant that's already been approved (or one you're about to approve)

## What success looks like
Every approved business books their 20-minute onboarding call within 3-4 days. The admin queue's "approved" tab shows the call date once they book; the `admin-onboarding-calendar.html` page shows a green chip with the linked business name next to every Module 3 booking. If 3 days pass without a booking, the cron sends nudge #1; another 7 days → nudge #2; another 7 → nudge #3 (final). After three nudges with no booking, the prospect is left alone — admin should follow up manually or archive.

## Steps — what happens automatically

### Step 1 — You click ✓ Approve
**Where:** `admin-business-applications.html`, Pending tab
**Do:** Click ✓ Approve on a card.
**Expect (server-side):**
- `businesses.approval_status` flips to `approved`.
- The migration 035 trigger creates the `business_partners` bridge so the customer landing URL goes live immediately.
- The `business-approval-email` Edge Function fires.

### Step 2 — Applicant receives the email
The email's subject is:
> *Your LYMX Business is live — [business name] (next step: book your 20-min onboarding call)*

The body opens with an amber-banner CTA: **"One required next step: book your free 20-minute onboarding call."** The big blue button under it goes to:
`https://getlymx.com/book-onboarding-call.html?biz=<their-slug>`

Below the CTA the email lists: their dashboard URL (with a magic-link sign-in when their auth account exists), their customer landing URL, and the 3-months-free billing terms.

### Step 3 — Applicant clicks the booking link
**Where (their browser):** `book-onboarding-call.html?biz=<slug>`
**What they see:**
- A blue banner near the top: 📅 *Booking your onboarding call for **[business name]***.
- The Business name field is pre-filled with the linked biz's display name.
- The slot grid renders 20-minute windows (host.slot_minutes was flipped to 20 in migration 096 — there's no longer any hardcoded "30" string anywhere on the page).

**They:** pick a day → pick a slot → fill in name + email + optional notes → Confirm.

**System-side, on submit:**
- `INSERT` into `onboarding_bookings` with `host_id`, `starts_at`, `ends_at`, `booker_email`, free-text `business_name`.
- Immediately after, the page calls `fn_mark_onboarding_booking_for_business(p_booking_id, p_biz_slug)` which:
  - Sets `onboarding_bookings.business_id` to the linked biz's id.
  - Mirrors `onboarding_call_booked_at = now()`, `onboarding_call_at = starts_at`, `onboarding_call_booking_id = booking.id` onto `businesses`.
  - Has a 5-minute freshness gate so anonymous callers can only link a booking they just created.
- The applicant downloads the ICS file and sees the success card.

### Step 4 — You see the linked booking on your calendar
**Where:** `admin-onboarding-calendar.html`
**Do:** Open the page (sidebar → Admin → Onboarding calendar).
**Expect:** Each upcoming booking row now shows a green chip below the booker name:
> 🏢 [linked biz display_name] · approved [date] · `<slug>`

That chip is clickable and routes you to the business applications queue so you can refresh context before the call. Bookings WITHOUT a linked biz (e.g. partners onboarding for themselves, walk-in prospects) still render normally — they just don't have the chip.

### Step 5 — If they don't book within 3 days
The `onboarding-followup-cron` Edge Function runs nightly (or whenever you call it manually). It queries the `v_unbooked_approved_businesses` view and sends a nudge for every approved-but-not-booked business whose `days_since_approval >= 3`. Throttle rules:
- **No more than one nudge per business per 7 days** — the cron skips anyone whose `last_nudge_at` is within the window.
- **No more than 3 nudges total per business** — after the third, the cron leaves them alone and admin should follow up manually or archive.

Each nudge sent gets logged to `onboarding_followup_sends` so the audit trail survives forever.

### Nudge sequence (escalating tone)
- **Nudge #1** (after 3+ days): *"Quick reminder: book your LYMX onboarding call for [biz name]."* Friendly nudge.
- **Nudge #2** (after another 7 days): *"Still need to book your LYMX onboarding call — [biz name]."* Acknowledges this is the second touch.
- **Nudge #3** (after another 7 days): *"Final reminder: book your LYMX onboarding call — [biz name]."* Says "reply if you need a different week, otherwise we'll archive."

## Manual trigger (rare)

If you want to fire the cron right now (e.g. you just approved a batch of 5 businesses and want to start the clock immediately), call the EF directly. Open the browser DevTools on any LYMX admin page and run:

```js
fetch(window.LYMX_CONFIG.SUPABASE_URL + '/functions/v1/onboarding-followup-cron', {
  method: 'POST',
  headers: {
    apikey: window.LYMX_CONFIG.SUPABASE_ANON_KEY,
    Authorization: 'Bearer ' + (await window.LYMX.getSession()).access_token,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ min_days_since_approval: 0, dry_run: true })
}).then(r => r.json()).then(console.log)
```

`dry_run: true` returns the list of businesses it WOULD email without actually sending. Drop `dry_run` (or set to false) to send live. `min_days_since_approval: 0` ignores the 3-day floor — useful only for testing.

## Scheduling the cron (one-time setup)

In the Supabase dashboard → Database → Cron Jobs:

```sql
SELECT cron.schedule(
  'onboarding-followup-nudge',
  '0 14 * * *',  -- 2pm UTC daily ≈ 7am Pacific
  $$ SELECT net.http_post(
       url := 'https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/onboarding-followup-cron',
       headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>', 'Content-Type', 'application/json'),
       body := '{}'::jsonb
     ) $$
);
```

(Substitute the actual service role key. The Supabase Cron Jobs UI is the recommended path — paste this into a new job.)

## Common edge cases

### Applicant clicks the link but their contact_email bounces
The booking flow doesn't require email verification at click time, but the nudge cron WILL surface the bounce — `onboarding_followup_sends.error_text` carries the Resend response. Filter the audit log for non-null error_text rows to find dead emails.

### Applicant books, then needs to reschedule
Today they cancel via `book.html?cancel_token=<token>` (covered by the existing booking-cancel EF) and book again. The cancel sets the booking row's status to `cancelled_by_booker` but does NOT clear `businesses.onboarding_call_booking_id` — that's a Module 4 polish task. If you see this in the wild, manually clear the column or wait for Module 4.

### You want to skip the call for a particular business
Manually flip `onboarding_call_booked_at` to `now()` on their `businesses` row. The cron will skip them after that. (No UI for this yet — DM Kenny if it becomes a regular ask and we'll add an admin button.)

### The cron job hits a Resend rate limit
The EF doesn't have built-in retry. The failed send is logged in `onboarding_followup_sends` with `error_text` set; the cron will pick that biz up again the next night (since `last_nudge_at` advanced). If you see persistent Resend errors, check the Resend dashboard for the actual reason.

## What's NOT in this playbook
- **The actual 20-minute call mechanics** — Module 4 will add Daily.co room creation + the post-call summary email.
- **Rescheduling polish** — Module 4 also clears `onboarding_call_booking_id` on cancel.
- **POS access + first issuance** — Module 5 (wallet+transactions pipeline).
- **Customer redemption** — Module 6.

See `playbooks/business-onboarding/README.md` for the full 7-step ops manual.
