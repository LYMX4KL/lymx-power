# getlymx.com — Email infrastructure handoff (2026-05-07)

> **You drive this since the Chrome extension hangs on Cloudflare.** Five steps, ~30 minutes total. Then we hand back to me to finish the Supabase deploy.

## What's already done

- ✅ Cloudflare Active for getlymx.com (DNS migration complete)
- ✅ AWS SES identity created in Fellora account: `arn:aws:ses:us-east-1:009846316105:identity/getlymx.com`
  - MAIL FROM: `ses.getlymx.com`
  - DKIM: RSA_2048_BIT, Easy DKIM
  - Status: Verification pending (will flip to verified ~10 min after DNS records propagate)

## Step 1 — Bulk-import 5 SES DNS records to Cloudflare (~2 min)

Same flow as you did for lymxpower.com last night.

1. Open https://dash.cloudflare.com → Domains → **getlymx.com** → DNS → Records
2. Click **Import and Export** → **Import zone file**
3. Choose file: [getlymx-ses-records.txt](computer://C:\Users\Kenny\Desktop\Gemini\LYMX Backend\getlymx-ses-records.txt)
4. Confirm import → 5 records added (3 DKIM CNAMEs + ses MX + ses SPF TXT)

## Step 2 — Enable Cloudflare Email Routing for getlymx.com (~5 min)

1. Cloudflare → getlymx.com → **Email** → **Email Routing** → **Get Started**
2. Cloudflare auto-adds the Email Routing MX + DKIM + SPF records on the bare domain — click **Add records and enable**
3. Add destination: your Gmail (`zhongkennylin@gmail.com`) — already verified for lymxpower.com so it should auto-show in dropdown
4. After enable, go to **Routing rules** → **Catch-all address** → **Edit**
5. Action: **Send to an email** → Destination: `zhongkennylin@gmail.com` → Save
6. Toggle catch-all to **Active** (green)

Now anything@getlymx.com forwards to your Gmail.

## Step 3 — Add getlymx.com to Resend (~3 min)

1. Open https://resend.com/domains
2. Click **Add domain** → enter `getlymx.com` → North Virginia (us-east-1) → continue
3. Choose **Auto configure** (the Cloudflare one) — same flow that worked for lymxpower.com
4. Approve the OAuth popup → Resend pushes 4 DNS records to Cloudflare (DKIM TXT, MX `send`, SPF `send`, DMARC `_dmarc`)
5. Wait for status to show "DNS verified" (5-10 min)

## Step 4 — Create Cloudflare API token (~3 min)

This is what the partner-provision-email Edge Function uses to create per-partner forwarding routes via Cloudflare API.

1. Cloudflare → top-right profile → **My Profile** → **API Tokens** → **Create Token**
2. Use **Custom token** (not a template)
3. Token name: `lymx-partner-email-bot`
4. Permissions:
   - Zone → **Email Routing Rules** → **Edit**
   - Zone → **DNS** → **Edit**
5. Zone Resources: **Include** → **Specific zone** → `getlymx.com`
6. TTL: leave blank (or set 1 year for rotation)
7. **Continue → Create Token**
8. Copy the token (starts with `cfut_`) **immediately** — you only see it once
9. Save it as `CF_API_TOKEN_LYMX` — paste it into a text file you'll open later when we set Supabase secrets

Also grab the **Cloudflare Zone ID** for getlymx.com:
- Cloudflare → getlymx.com → Overview tab → right sidebar → **Zone ID** → copy
- Save as `CF_ZONE_ID_LYMX`

## Step 5 — Create AWS SES SMTP credentials (~3 min)

This is what the Edge Function uses to send the welcome email via SES SMTP relay.

1. Open https://us-east-1.console.aws.amazon.com/ses/home?region=us-east-1#/smtp
2. Click **Create SMTP credentials**
3. IAM user name: leave default (`ses-smtp-user.YYYYMMDD-NNNNNN`) or rename to `lymx-ses-smtp`
4. Click **Create**
5. **CRITICAL:** the next page shows the SMTP username + SMTP password — you only see the password ONCE. Click **Download credentials .csv** to save them.
6. Move the downloaded CSV to a secure place (1Password, password manager) — these are the values for `SES_SMTP_USERNAME` and `SES_SMTP_PASSWORD` env vars in Supabase

## Status check

When all 5 steps are done, message me:

```
- [ ] Step 1 done: 5 SES DNS records imported to Cloudflare
- [ ] Step 2 done: Cloudflare Email Routing active, catch-all → Gmail
- [ ] Step 3 done: Resend Auto-configured for getlymx.com, DNS verified
- [ ] Step 4 done: CF_API_TOKEN_LYMX + CF_ZONE_ID_LYMX saved
- [ ] Step 5 done: SES_SMTP_USERNAME + SES_SMTP_PASSWORD saved
```

Then I'll drive: migration 005 → set 9 Supabase Edge Function secrets → deploy 3 partner-email Edge Functions → smoke test.

## Cheat sheet — env vars you'll need ready before Supabase

By the end of these 5 steps you should have these values saved (do NOT paste into chat — keep in a local text file or password manager):

```
CF_ZONE_ID_LYMX=<from Cloudflare Overview>
CF_API_TOKEN_LYMX=cfut_...
SES_REGION=us-east-1
SES_SMTP_USERNAME=AKIA... (looks like an IAM access key)
SES_SMTP_PASSWORD=<long base64 string>
RESEND_API_KEY=re_... (Resend → API Keys → create)
EMAIL_FROM=LYMX <hello@getlymx.com>
LYMX_DOMAIN=getlymx.com
LYMX_SITE_URL=https://getlymx.com
```

Tell me "ready" + the list of done checkboxes and I'll resume.
