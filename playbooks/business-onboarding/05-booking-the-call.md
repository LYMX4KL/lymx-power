---
slug: business-onboarding-05-booking-the-call
title: Book + run the 20-minute onboarding call (Daily.co room + summary)
project: LYMX Power
role: business-prospect
prereqs:
  - business_approved
duration_min: 22
difficulty: easy
last_verified: 2026-05-26
related:
  - business-onboarding/README
  - business-onboarding/03-approval
  - business-onboarding/04-approval-email-and-callback
supersedes: null
---

# Book + run the 20-minute onboarding call

This is what happens for a prospect business between clicking the approval email and finishing their first onboarding call with the LYMX team. Module 4 closed two gaps in the original flow: every booking now automatically gets a video room (Daily.co when an API key is configured, falls back to meet.jit.si otherwise), and the call-summary Edge Function picks up `meeting.ended` events for onboarding calls (in addition to the existing team-calendar bookings) so no-shows surface automatically.

## What you'll need
- The approval email from Module 3 (subject: *"Your LYMX Business is live — [name] (next step: book your 20-min onboarding call)"*)
- 20 minutes on your calendar within the next 14 days

## What success looks like
Your booking confirmation email arrives within a minute of confirming a slot, contains the join link in three places (CTA button, plain URL, ICS calendar attachment), and is mirrored in the LYMX team's inbox so the host can prep. When you click "Join the call" at the scheduled time, a Daily.co or Jitsi room opens — no install, just a browser tab.

## Steps (for the business prospect)

### Step 1 — Click "Book your 20-min onboarding call →" in the approval email
**Where:** Anywhere the email landed (Gmail, Outlook, mobile)
**Do:** Click the blue button. Or paste the URL from below it into your browser.
**Expect:** You land on `https://getlymx.com/book-onboarding-call.html?biz=<your-slug>`. A blue banner at the top reads *"📅 Booking your onboarding call for [your business name]."* The Business name field on the form will already be filled in for you.

### Step 2 — Pick a day, then a time slot
**Where:** The booking page (no login required)
**Do:** Tap a day in the horizontal day picker (next 14 days), then tap one of the 20-minute slots that appears below.
**Expect:** A details form slides into view with a blue "Selected time" summary line. The time shown is in your local timezone (the page detects it automatically).

### Step 3 — Confirm
**Where:** The details form
**Do:** Your business name is pre-filled. Enter your name + email (and phone, optional). If you have anything specific to discuss, add it in the Notes field. Click "Confirm booking."
**Expect:** A green success card with three things:
1. *"See you on [day] [time]"* — your slot, in plain English.
2. **A clickable join link** (Daily.co room URL or meet.jit.si fallback).
3. A note that a confirmation email + calendar invite were just sent.

You'll also see a "📅 Download calendar invite" button — use it if your email client didn't auto-attach the ICS.

### Step 4 — Confirmation email
**Where:** Your inbox (the email you typed in Step 3)
**Subject:** *"Your LYMX onboarding call is confirmed — [day] [time] [TZ]"*
**Inside:**
- Detail table: when / duration / host name / business
- A big blue "Join the call →" button with the same link as the success card
- The ICS calendar invite as an attachment (`lymx-onboarding-call.ics`)
- Note about replying if you need to reschedule

If you don't see it within 60 seconds, check spam. The sender is `kenny@lymxpower.com`.

### Step 5 — Join at the call time
**Where:** The Join link (CTA button OR plain URL OR calendar event location)
**Do:** Click ~30 seconds before the slot starts. The host is usually there a minute early.
**Expect:** A browser tab opens with the Daily.co or Jitsi UI. Allow camera + mic, click "Join meeting." No app install required.

### Step 6 — During the call
**What the host covers:**
- Confirming your POS / payment flow integrates with LYMX (1 minute)
- Walking through your business dashboard (3-5 minutes)
- Issuing your first rewards in test mode (3-5 minutes)
- Setting up your customer landing URL share strategy (2-3 minutes)
- Q&A and anything specific to your business (rest of the time)

Most calls finish in 15-18 minutes; we leave a 5-minute buffer for "any other questions?"

### Step 7 — After the call
**What happens automatically when the call ends:**
- The host hangs up. Daily.co (or Jitsi) sends a `meeting.ended` event to the LYMX call-summary Edge Function.
- The EF marks your `onboarding_bookings.status` as `completed` (or `no_show` if duration was under 60 seconds or fewer than 2 participants joined).
- `onboarding_bookings.completed_at` and `video_room_data.meeting_ended_data` are written for audit.

**If you missed the call** (e.g., your kid was sick, internet died):
- The system detects the no-show and pings the host with a heads-up so they can email you directly to reschedule.
- You don't lose anything — just reply to the original confirmation email and the host will set up a fresh slot.

### Step 8 — You're set
After the call you're free to start issuing real LYMX rewards. The dashboard now shows live counts; transactions flow through the issuance pipeline (Module 5 — wallet+transactions unification). Customers who scan your QR or click your `welcome.html?biz=<slug>` URL start earning.

## Steps (for the host / LYMX team)

### Step A — You get a heads-up email
**Where:** `kenny@lymxpower.com` inbox
**Subject:** *"New onboarding call — [booker name] · [business name] on [day] [time]"*
**Inside:**
- Booker details (name, email, phone if provided)
- Linked business name + slug (when the booking came in via `?biz=<slug>`)
- Their notes
- Direct "Join the call →" link to the same Daily/Jitsi room

### Step B — Prep
**Do:** Click the `admin-business-applications.html` link in the heads-up email to pull up the application card. Skim the intake chips (EIN, License, Entity type, etc.) and the invitation source (which partner sent it, if any). 30-60 seconds is enough.

### Step C — Join + run the call
Same room URL as the booker. Daily.co with cloud recording when `DAILY_ENABLE_RECORDING=true` is set in env vars; otherwise plain Daily; or Jitsi fallback if `DAILY_API_KEY` is absent.

### Step D — After the call
- The status flips automatically (see Step 7 above). Open `admin-onboarding-calendar.html` to confirm the row moved from "Upcoming" to "Past" with the right status.
- The linked-biz chip on the calendar row tells you which business this was for (Module 3) — click it to jump back to the application card.

## Common edge cases

### The Join link doesn't open / Daily room expired
Daily rooms expire 30 minutes after the booking end time. If you click hours after the call should have happened, the room is gone. To rejoin within the buffer: just click again. To reschedule: reply to the confirmation email.

### Browser blocks camera / mic
- **Chrome:** click the lock icon next to the URL, set Camera + Microphone to Allow, reload.
- **Safari (iOS):** Settings → Safari → Camera/Microphone → Allow.
- **Firefox:** lock icon → Permissions → Camera/Mic → Allow.

### The call ended but the status didn't update
That means the Daily/Jitsi webhook didn't reach the call-summary EF. The host can manually patch the row from `admin-onboarding-calendar.html` (set status to Completed via the Cancel/Edit menu — same UI flips the status). Webhook config lives in Daily.co dashboard → Developers → Webhooks; URL should be `https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/call-summary`.

### You want to skip the call for a particular business
Open `book-onboarding-call.html?biz=<slug>` yourself, book any slot, then mark it completed manually. Or — for testing — patch `onboarding_call_booked_at` directly on the business row.

## What's NOT in this playbook
- **POS setup specifics** — covered in Module 5 (wallet+transactions) and the per-POS integration docs.
- **Recording / transcript** — works for Daily.co rooms when `DAILY_ENABLE_RECORDING=true` and `DAILY_ENABLE_TRANSCRIPTION=true` are set; the existing call-summary EF handles the team-calendar transcript flow but the onboarding-bookings transcript flow is Module 6+ scope.
- **Customer redemption** — Module 6.

See `playbooks/business-onboarding/README.md` for the full 7-step ops manual.
