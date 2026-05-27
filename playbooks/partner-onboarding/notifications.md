---
slug: partner-notifications
title: Your partner notifications feed
project: LYMX Power
role: partner
prereqs:
  - active_partner_account
duration_min: 2
difficulty: easy
last_verified: 2026-05-27
related:
  - comp-plan-partner-walkthrough
  - business-onboarding/08-settlement
supersedes: null
---

# Your partner notifications feed

The Notifications page is your event feed as a partner. Every commission, every downline activation, every settlement payout, and any system messages from LYMX admin show up here.

## What lands in your feed

- **Commission earned** — a new commission row was added to your settlement queue (signup bonus, override, qualifier bonus). Tap to jump to Partner → Payouts.
- **Direct activation** — a business you signed up was just approved by admin. Your activation commission deposits on the next settlement run.
- **Downline signup** — a partner joined LYMX under one of your downline branches.
- **Qualifier progress** — Founding 25 milestone updates (e.g., 5th activation = $1,000 qualifier bonus).
- **Settlement paid** — your commission settlement was just paid out via ACH.
- **System** — admin announcements, training nudges, fraud alerts.

## How to use it

1. **Open the page.** Sidebar → Partner → Notifications, or go directly to `/notifications.html`.
2. **Scan the unread items.** Unread rows have a small blue dot on the left and a subtle blue tint.
3. **Tap a row to read.** Tapping marks it read (the dot disappears, the tint clears) and, for partner notifications, opens the relevant target page — e.g., a commission notification jumps to Partner → Payouts.
4. **Mark all read** with the button in the top-right when you want a clean slate.

## How read state works

- **Customer-side rows** (earn / spend / referrals from `lymx_issuances`) are marked read in memory only — they re-appear unread if you reload. That's by design: those rows are an activity log, not a true inbox.
- **Partner rows** (commission / activation / settlement / system from `partner_notifications`) are marked read in the database via `fn_mark_notification_read`. Read state persists across reloads and devices.

## What you might run into

**Page is empty even though I have commissions.** The notification triggers (migration 110) fire on NEW commission inserts. Commissions created before the triggers shipped won't have backfilled notifications. As new activity happens, your feed populates.

**A commission shows up but the row isn't tappable / doesn't link anywhere.** That's a missing `target_url` on the notification. Tell Kenny — usually fixes by adjusting the trigger that emitted it.

**I'm getting fake notifications I didn't earn.** Notifications can only be inserted by SECURITY DEFINER backend functions or admins. There's no path for another partner or customer to inject a notification into your feed. If you see something fake, it's likely a trigger bug — report it.

## Glossary

- **kind** — the event category (commission_earned, direct_activation, downline_signup, qualifier_progress, settlement_paid, system). Maps to the visual icon class on the page.
- **target_url** — the relative URL the row links to. Tapping a partner notification follows this link.
- **fn_emit_partner_notification** — the backend-only RPC that inserts a row. Called from triggers (auto-emit on commission insert, business approval flip, settlement payment) and admin manual sends.
- **fn_mark_notification_read** — what the page calls to persist a tap. RLS + auth.uid() check ensures you can only mark your own.
