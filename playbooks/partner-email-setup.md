---
slug: partner-email-setup
title: Connect your @getlymx.com email to Gmail
project: LYMX Power
role: partner
prereqs:
  - signed_in_as_partner
  - has_partner_email_provisioned
duration_min: 5
difficulty: easy
last_verified: 2026-05-24
last_revised: 2026-05-24 (added Step 0 — Cloudflare destination verify)
related:
  - partner-pitch-toolkit
  - partner-book-rachel
---

# Connect your @getlymx.com email to Gmail

When customers and prospects see emails from your branded `you.name@getlymx.com` address, you look like part of LYMX, not someone forwarding from a personal gmail. This playbook walks you through a one-time setup that lets you SEND from your @getlymx.com address inside your normal Gmail inbox. Replies still land in your personal gmail, so there's nothing new to check.

## Quick context — two LYMX email domains, different jobs

LYMX has two email domains and they do different things. Knowing which is which prevents confusion:

| Domain | What it's for | Do partners connect it to Gmail? |
|---|---|---|
| **getlymx.com** | Daily work email — what you send to prospects, customers, businesses you're recruiting. The "from" address customers see on your outreach. | **Yes** — this playbook walks you through that connection. |
| **lymxpower.com** | Marketing email — newsletters, campaign sends, blog notifications. Sent automatically by LYMX from `hello@lymxpower.com` and `news@lymxpower.com`. | **No** — partners don't need to connect or configure anything here. It just runs behind the scenes. |

So when you receive your welcome email, you'll see one `@getlymx.com` address to set up (the steps below) and you can ignore anything about lymxpower.com — that's our problem, not yours.

## What you'll need

- Your personal Gmail account that you signed up to LYMX with (e.g. `yourname@gmail.com`).
- Your LYMX partner welcome email, sent shortly after you became a partner — subject starts with "Welcome to LYMX" and contains a section titled "YOUR WORK EMAIL IS READY".
- 5 minutes.

## What success looks like

When you compose a new message in Gmail, the "From" dropdown shows TWO options: your personal `yourname@gmail.com` AND your branded `yourname@getlymx.com`. You pick the branded one when emailing prospects and your gmail when emailing friends.

## Steps

### Step 0 — Verify your inbox with Cloudflare (this is the one that bites everyone)
**Where:** Your personal Gmail inbox (the one you signed up to LYMX with).
**Do:** Search your inbox for an email from `Cloudflare Email <noreply@notify.cloudflare.com>` with subject `Verify your email address with Cloudflare`. Check Spam and Promotions too — Cloudflare verifications often land there.
**Click the verification link inside that email.** A Cloudflare page should confirm 'Email address verified.'
**Expect:** Your gmail is now registered as a valid destination for `<you>@getlymx.com`. Any future email to your @getlymx.com address can now be forwarded to your gmail.
**If you don't see the Cloudflare email anywhere:** reply to your LYMX welcome email and ask us to re-send it. Without this step, Step 1-7 below will all run but Gmail will get stuck waiting for a verification code that's being silently routed to the wrong inbox.
**Why it matters:** Helen Chen lost most of a day on 2026-05-24 because this step wasn't explicit. The credentials and infrastructure were perfect — but no routing rule existed for her @getlymx.com alias until her destination inbox was verified.

### Step 1 — Open the latest welcome email
**Where:** Your personal Gmail inbox.
**Do:** Search for "LYMX welcome" or "your work email is ready". Open the most recent one. Scroll down to the section titled "YOUR WORK EMAIL IS READY".
**Expect:** You see a card with five lines: SMTP Server, Port, Username, Password, Connection.
**If you see multiple LYMX welcome emails:** use the most recent one — older copies may have outdated credentials.

### Step 2 — Open Gmail's Send-mail-as settings
**Where:** Gmail web (not mobile app — desktop browser only).
**Do:** Click the gear icon (top-right) → "See all settings" → click the "Accounts and Import" tab.
**Expect:** You see a "Send mail as" section with your gmail address listed.

### Step 3 — Start adding the new address
**Where:** "Send mail as" section.
**Do:** Click "Add another email address". A small window opens.
**Expect:** A form with "Name" and "Email address" fields.

### Step 4 — Enter name + LYMX address
**Where:** The "Add another email address" window.
**Do:**
1. Name: type your full name as you want it to appear (e.g. "Helen Chen").
2. Email address: type your full `@getlymx.com` address from the welcome email (e.g. `helen.chen@getlymx.com`).
3. **Uncheck "Treat as an alias"** — this is important; if you leave it checked, replies route back to your gmail instead of staying threaded.
4. Click "Next Step".
**Expect:** The form changes to "Send mail through your SMTP server".

### Step 5 — Paste the SMTP settings from the welcome email
**Where:** The "Send mail through your SMTP server" window.
**Do:** Copy each line from your welcome email's "YOUR WORK EMAIL IS READY" card into the matching field:
- SMTP Server: paste from the email
- Port: 587 (it should already be 587 by default)
- Username: paste the `AKIA...` value from the email (case-sensitive)
- Password: triple-click the password line in the email to select ONLY the password, then paste. Double-check no leading or trailing space.
- Connection: select "Secured connection using **TLS**" (this should be the default)

Click "Add Account".
**Expect:** Gmail accepts the credentials and moves to the verification step ("A confirmation code is required"). Your @getlymx.com inbox forwards to your personal gmail, so the code arrives in seconds.

### Step 6 — Enter the verification code
**Where:** The verification window Gmail just opened.
**Do:** Check your gmail inbox for an email from "Gmail Team" with a numeric verification code. Copy the code, paste it into the verification window, click Verify.
**Expect:** Gmail closes the window and your `@getlymx.com` address appears in "Send mail as" with "(Default: No)". Setup is complete.

### Step 7 — Test by sending yourself an email
**Where:** Gmail compose window.
**Do:** Click "Compose" → from the "From" dropdown, pick your `@getlymx.com` address → put your own personal gmail in the To field → send a quick test.
**Expect:** Within seconds you receive the test email in your personal gmail inbox. The "From" address reads `Your Name <you.name@getlymx.com>`.

## Common errors

| Error you see | What's happening | How to fix |
|---|---|---|
| "Couldn't finish setting up this account" at Step 5 | SMTP authentication failed — Gmail couldn't log in to AWS SES with the credentials provided. | (a) Re-copy the password from the welcome email, paying attention to whitespace. Triple-click to select just the password before copying. (b) Verify Username is the `AKIA...` value, not your email address. (c) If both look correct and it still fails, message Kenny — could be a credential rotation timing issue. |
| Verification code never arrives at Step 6 | The verification email from Gmail wasn't routed back to your personal inbox — almost always because Step 0 (Cloudflare destination verify) was skipped. | (a) Wait 60 seconds, sometimes there's a delay. (b) Check spam/promotions for the **Cloudflare** verification email — if it's there, click it now and the next Gmail re-send of the code will arrive. (c) If you can't find the Cloudflare email anywhere, ask Kenny to re-send it via the Cloudflare dashboard. |
| "Treat as an alias" checked accidentally at Step 4 | Replies route back to your gmail mailbox and break threading. | Go back to "Accounts and Import" → "Send mail as" → click "edit info" on your @getlymx.com row → uncheck "Treat as an alias". |
| Gmail doesn't show "From" dropdown after Step 7 | The new address didn't save, or you're in Gmail's mobile app (Send-as only works from desktop browser composer). | Reload Gmail on desktop. Verify the address shows under "Send mail as" with "Verified" status. |

## Reference / under the hood

This section is for technical readers (Kenny, future developers). End users don't need to read it.

- **Why two domains:** `getlymx.com` is the transactional/work-email domain (DKIM + SPF + DMARC tuned for high deliverability, Cloudflare Email Routing forwards inbound to personal gmail). `lymxpower.com` is the marketing/outreach domain (separate DKIM/SPF set up, different reputation pool so a complaint on a marketing send doesn't burn the work-email domain).
- **AWS SES SMTP credentials:** Username = IAM access key ID (`AKIA...`, 20 chars). Password = HMAC-SHA256-derived SMTP password from the IAM secret access key, prefixed with version byte `0x04`, base64-encoded (44 chars). The derivation algorithm is documented in `Desktop\Gemini\spaces\<workspace>\memory\feedback_ses_smtp_password_derivation.md`.
- **Welcome email is generated by:** `LYMX Backend\functions\partner-provision-email\` — reads `SES_SMTP_USERNAME` + `SES_SMTP_PASSWORD` env vars verbatim and injects them into the welcome card template at `LYMX Backend\functions\_shared\email\templates\partner-welcome.ts` line 236.
- **Verification email forwarding chain:** Gmail sends verification code → MX record for `getlymx.com` (Cloudflare) → Email Routing rule (per-address or catch-all) → forwards to destination (partner's personal gmail). Destination addresses must be verified once in Cloudflare's Email Routing dashboard before the forward works.
- **To trigger a re-send of the welcome email** for a stuck partner: POST to `/functions/v1/partner-provision-email` with `{ partner_id: "<uuid>", force_welcome: true }`.

## Update history

- 2026-05-24 (revised) — Added Step 0 for Cloudflare destination verification after Helen Chen got stuck on it for hours. The credentials and SMTP setup were correct but the routing rule was never created because her destination inbox was 'Pending verification' in Cloudflare. Root cause now Step 0 in the playbook AND in the welcome email template.
- 2026-05-24 — First version. Verified end-to-end by Kenny on his own `kenny.lin@getlymx.com` setup. Helen Chen used this playbook to debug her own setup (active diagnosis ongoing — Cloudflare routing destination verification may be the missing piece if credentials check out).
