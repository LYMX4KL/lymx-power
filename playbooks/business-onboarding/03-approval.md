---
slug: business-onboarding-03-approval
title: Review a pending business application
project: LYMX Power
role: admin
prereqs:
  - signed_in_as_admin
duration_min: 5
difficulty: easy
last_verified: 2026-05-26
related:
  - business-onboarding/README
  - business-onboarding/01-invite
  - business-onboarding/02-signup
supersedes: null
---

# Review a pending business application

A prospect has signed up — either through an invitation link you (or a partner) sent, or by finding `biz-signup.html` directly. This playbook walks you through reviewing what they submitted and deciding among three outcomes: **Approve**, **Request more info**, or **Reject**.

The "Request more info" path is the new Module 2 capability. Use it whenever the application is close-but-not-quite — most real signups need at least one round-trip before they're ready to approve, and bouncing back-and-forth in email is faster than rejecting then re-applying.

## What you'll need
- An admin account (Kenny / Helen / any staff with admin role)
- A few minutes per application

## What success looks like
Every pending application ends up in one of three terminal states: **Approved** (the business is live, customers can earn LYMX there), **Rejected** (with a reason the applicant can see), or still **Pending** while we wait on a clarification reply from them.

## Steps

### Step 1 — Open the approval queue
**Where:** `https://getlymx.com/admin-business-applications.html` (sidebar → Admin → Business applications)
**Do:** Sign in. The page opens on the **Pending** tab by default.
**Expect:** You see one card per pending application. The counter on the Pending tab matches the number of cards.

### Step 2 — Read the application
**Where:** Each Pending card
**Do:** Skim the card top to bottom. You'll see:

1. **Header** — business name, category, contact email + phone, and a pending badge.
2. **Invitation source** (if any) — a small blue tag near the top that reads:
   - *"Invited via Kenny on May 25"* (admin-sent invite), OR
   - *"Invited via [partner name] on May 24"* (partner-sent invite), OR
   - no tag at all if the prospect found the signup page directly.
3. **Intake summary** — a small chip row showing what they filled in: `EIN ✓` `License ✓` `Entity LLC` `2017` `Website ↗`. Anything they didn't fill in is shown grayed out, so you can spot gaps at a glance.
4. **Uploaded docs** — count + verified count, e.g. `📎 3 docs uploaded · 1 verified`. Click to drill into the document list.
5. **Submitted timestamp** + the **customer landing URL** that will go live the moment you approve.

**Expect:** Enough context to decide one of the three outcomes below without leaving the card.

### Step 3 — Decide the outcome

#### Path A — Approve
**When:** The application is complete and the business looks legitimate (real address, plausible category, verifiable EIN/license, etc.).
**Do:** Click **✓ Approve**.
**Expect:**
- Toast: *"Approved + email sent. Their welcome URL is now live."*
- The card disappears from Pending and reappears under the Approved tab.
- The applicant receives the approval email containing their welcome URL + the next-step (book the 20-minute call with Rachel).

#### Path B — Request more info
**When:** The application is close, but you need ONE more thing before approving. Examples:
- *"Your EIN doesn't match the legal name on file with the state. Can you confirm or send a copy of your EIN letter?"*
- *"Could you upload your current business license? The one on file expired in 2023."*
- *"Your hours show closed all day Sunday but your website lists brunch service — which is current?"*

**Do:**
1. Click **🔄 Request more info** on the pending card.
2. A modal opens with a text field.
3. Type your question in plain English. Be specific — they'll see your text verbatim in their email inbox. Multi-line is fine; line breaks are preserved.
4. Click **Send request**.

**Expect:**
- Toast: *"Request sent — applicant emailed."*
- The card stays in Pending but now shows an amber banner: *"Awaiting response: [your question]"* with the timestamp of when you asked.
- The applicant receives an email titled "Quick follow-up on your LYMX application for [business name]" with your question in a blue quote block. They reply directly — the reply lands in `kenny@lymxpower.com`.

**Once they reply** (which currently arrives in your normal email inbox — Module 3 will surface the reply on the admin card):
1. Read their answer.
2. If satisfied, return to the card and click **✓ Approve**.
3. If still not satisfied, click **🔄 Request more info** again — this replaces the prior question with a new one. The first question remains in the audit log; only the *visible* state on the card is the latest question.

#### Path C — Reject
**When:** The application clearly doesn't fit (wrong vertical, suspicious data, prospect already has another approved business in the system, etc.).
**Do:**
1. Click **✗ Reject**.
2. A prompt asks for a rejection reason.
3. Type a clear reason in plain English. The applicant sees this verbatim.
4. Click OK.

**Expect:**
- Toast: *"Rejected + email sent."*
- Card disappears from Pending, reappears under the Rejected tab.
- Applicant receives a rejection email with your reason.

### Step 4 — Confirm the outcome stuck
**Where:** The Pending tab counter
**Do:** Check that the counter dropped by one (Approve / Reject) OR the card now has the amber "Awaiting response" banner (Request more info).
**Expect:** The state you intended is reflected immediately. Click the page Reload icon if anything looks stale.

## Common edge cases

### The applicant filled the form but I can't tell who invited them
Look at the "Invitation source" tag. If it's missing, the prospect arrived at biz-signup.html directly (no `?invite_token=` in their URL). That's fine — review on its own merits. If you suspect a partner DID invite them but the link was shared incorrectly, ask the applicant directly in a "Request more info" message.

### The EIN field is blank
EIN is optional in the intake form (sole proprietorships often don't have one). If the business looks legitimate otherwise — verifiable license, plausible category, working website — that alone isn't grounds to reject. Use "Request more info" if you want to confirm their entity type.

### Multiple applications from the same owner email
The signup form allows the same auth user to own multiple businesses (locations, brands, etc.). Each row is reviewed independently. If you see a pattern that looks like spam or testing, click into the contact email and check the other applications — and if they're test rows, reject them with reason "test signup, not a real business" so they don't pollute the queue.

### The applicant replied to my "Request more info" email
Today their reply lands in `kenny@lymxpower.com`. Read it, then return to the admin queue and either approve (if satisfied) or send another round of questions. Module 3 of the roadmap surfaces replies directly on the admin card so you don't have to context-switch.

## When this goes wrong

- **"Approve" button is grayed out** — you're not signed in as admin. Sign out, sign back in with an admin account.
- **No email arrived after Approve / Request more info / Reject** — check the applicant's spam folder first; then check `admin-emails.html` for delivery status. If the row says `failed`, the contact email may be bouncing — try contacting them through another channel.
- **The card shows "Awaiting response" but you don't remember asking** — another admin (Helen, Kenny) likely sent it. The `Requested by [name] · [timestamp]` line under the banner tells you who.
- **You clicked Reject but want to undo** — open the Rejected tab and click **Reconsider (mark pending)**. The card moves back to Pending; you can then approve. Note: the applicant has already received the rejection email — follow up manually if you reverse the decision.

## What's NOT in this playbook
- **Approval email content** (Module 3 — currently the approval email mentions Rachel + 20-min call but the booking-required follow-up cron isn't shipped yet).
- **Onboarding call scheduling** (Module 4 — book-onboarding-call.html).
- **POS access + first issuance** (Module 5 — wallet+transactions pipeline).
- **Customer redemption** (Module 6).

See `playbooks/business-onboarding/README.md` for the full 7-step ops manual.
