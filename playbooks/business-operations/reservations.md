---
slug: business-operations-reservations
title: Manage table reservations
project: LYMX Power
role: business
prereqs:
  - approved_business
duration_min: 3
difficulty: easy
last_verified: 2026-05-27
related:
  - business-onboarding/07-customer-redeems
supersedes: null
---

# Manage table reservations

Customers can request a table on your business profile page. Every request lands in your Reservations inbox where you confirm, decline, or mark seated. The customer sees the status change immediately on their My Reservations page.

## Where it lives

Sidebar → Business → Operations → **Reservations** (or `/biz-reservations.html` directly). The header shows your business name; tabs split the queue into Pending, Confirmed (includes seated), and All.

## The lifecycle

A reservation moves through these statuses:

- **pending** — customer just submitted. Waiting on your decision.
- **confirmed** — you accepted. Optionally with a note to the customer (e.g. "Table 7, ask for Maria").
- **seated** — guest arrived. Mark this when they walk in.
- **no_show** — confirmed time passed and the guest never showed.
- **cancelled** — either you declined, or you cancelled a confirmed booking. Reason is required and shown to the customer.

## Step-by-step

1. **Open the inbox.** The Pending tab is selected by default and shows requests in time order (soonest first).
2. **Triage a request.** Each card shows: party size, requested time, contact info, and any special notes the customer left.
3. **To confirm:** open the "Add a note for the customer" toggle if you want to include table details, then click **Confirm**. The customer sees the green confirmed pill instantly.
4. **To decline:** click **Decline** and enter a brief reason (shown to the customer). The card flips to cancelled and leaves the Pending tab.
5. **When the guest arrives:** flip to the Confirmed tab and click **Mark seated** on their card.
6. **If they no-show:** flip to Confirmed, find the past-time card, click **No-show**. (Track this so you can flag repeat offenders later.)
7. **To cancel a confirmed booking:** click **Cancel** on the confirmed card and enter a reason — same UX as decline but later in the flow.

## What you might run into

**A request shows up multiple times.** Customers can submit the same time slot more than once if your business page allows it. Decline the duplicates with reason "Duplicate request — accepted the earlier one."

**The customer's contact info is missing.** The form on your business page collects email + phone, but only the name + party size + time are strictly required. Without contact info you can still confirm/decline — the customer sees the status update on their My Reservations page even without a notification.

**Confirmed time is in the past and the customer never came.** Mark no-show. The status updates immediately. Avoid leaving stale "confirmed" rows in the queue — they clutter the Confirmed tab.

**I want to suggest a different time.** Sprint 4 ships just confirm/decline; "suggest alternate time" is a Sprint 5 enhancement. For now, decline with reason "Could you try 7pm instead? — text me at <number>" and the customer can resubmit.

**The Pending count badge stays at 0 after a new request lands.** Refresh the page. Real-time push is a Sprint 5 enhancement.

## Glossary

- **`table_reservations` table** — the canonical store (migration 085). One row per request. RLS lets the business owner read + update their own; admin reads all.
- **`reservation_status` enum** — pending / confirmed / seated / no_show / cancelled. UPDATE the column directly via RLS; no separate RPC needed.
- **Customer side** — `/my-reservations.html` shows the same rows filtered by `user_id = auth.uid()`. Status changes you make here propagate instantly.
