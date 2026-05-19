# lymxpower.com — SES DNS records to add (2026-05-06)

> **STATUS:** Record 1 of 5 already added (DKIM CNAME #1). Records 2-5 still pending.
>
> **FASTEST PATH FOR REMAINING 4 RECORDS — bulk import:**
> 1. In Cloudflare → lymxpower.com → DNS → Records → click **Import and Export** → **Import zone file**
> 2. Click **Choose file** and select `lymxpower-remaining-dns.txt` (in this same folder)
> 3. Cloudflare will preview the 4 records → click **Import**
> 4. Done in 30 seconds.

The AWS SES identity for `lymxpower.com` was created tonight in the **Fellora** AWS account (009846316105) in **us-east-1**. SES will not start verifying until these 5 records resolve. Add them to Cloudflare DNS for `lymxpower.com`.

## How to add (fastest path)

1. Open https://dash.cloudflare.com → Domains → lymxpower.com → DNS → Records
2. Click **Add record** for each row below
3. Set **Proxy status: DNS only** (gray cloud) for all of them — mail records cannot be Cloudflare-proxied
4. Save

Cloudflare's name field auto-appends `.lymxpower.com`, so type only the SUBDOMAIN portion shown in the **Name** column below.

## The 5 records

### DKIM (3 × CNAME)

| # | Type | Name (subdomain only) | Target / Value |
|---|---|---|---|
| 1 | CNAME | `2qv2hb45ukkz2khqf4fgbjvj4tdcbidt._domainkey` | `2qv2hb45ukkz2khqf4fgbjvj4tdcbidt.dkim.amazonses.com` |
| 2 | CNAME | `rtidxbgznpwe2o3l3cwk7omuv6dro7nm._domainkey` | `rtidxbgznpwe2o3l3cwk7omuv6dro7nm.dkim.amazonses.com` |
| 3 | CNAME | `qmtpsbjkv7x6phkrruqm4piyo7t42kvt._domainkey` | `qmtpsbjkv7x6phkrruqm4piyo7t42kvt.dkim.amazonses.com` |

### MAIL FROM (1 × MX, 1 × TXT)

| # | Type | Name | Value | Priority |
|---|---|---|---|---|
| 4 | MX | `ses` | `feedback-smtp.us-east-1.amazonses.com` | 10 |
| 5 | TXT | `ses` | `v=spf1 include:amazonses.com ~all` | — |

(For the TXT record, do NOT include the surrounding quotes when pasting into Cloudflare — Cloudflare adds them automatically.)

## After you add them

- Go back to AWS SES → Identities → lymxpower.com
- Click the refresh icon
- Within 5–15 minutes both DKIM configuration and MAIL FROM configuration should flip from **Pending** → **Verified** (green)
- Once Verified, lymxpower.com inherits the Fellora AWS account's existing SES production access (no 24-hour wait)

## What's already done (no action needed)

- Cloudflare Email Routing on `lymxpower.com` — catch-all `*@lymxpower.com` forwards to your Gmail (active)
- Resend domain — 4 records on `send.lymxpower.com` / `resend._domainkey` / `_dmarc` already auto-configured via Resend's Cloudflare OAuth
- Domain registrations — `lymxpower.com` and `joinlymx.com` both bought, auto-renew on, expire May 2027

## What's still ahead (next session)

- After SES Verified: you can send marketing/cold-outreach mail from `@lymxpower.com` via SES SMTP credentials
- Optionally generate a `lymx-ses-bot` IAM user + access key for Netlify env vars (per STACK-PLAYBOOK.md step 10f-h) — only needed once you wire the actual sending code
- `joinlymx.com` is parked, no setup needed unless you decide to use it
