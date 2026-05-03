# Partner Email Provisioning — LYMX Setup Checklist

Concrete, step-by-step LYMX setup for the `*@getlymx.com` partner email pipeline. Companion to the multi-tenant architecture doc at `Gemini/shared accross projects/COMPANY-EMAIL-ARCHITECTURE.md` — that one explains *why*, this one tells you *what to click*.

**Total time when wifi is solid:** ~60 minutes for first-time setup. The work splits into four chunks: Cloudflare (~15 min), Amazon SES (~15 min + a 24hr wait for production access), Resend (~5 min), Supabase env vars + deploy (~15 min).

**Prerequisites before starting:**

- `getlymx.com` domain is purchased (you've got this — currently at GoDaddy).
- Migrations 004 + 005 ran successfully on Supabase (check `partner_emails` table exists in the Table Editor).
- The 3 source files are in GitHub: `migrations/005_*`, `functions/partner-provision-email/`, `functions/_shared/email/templates/partner-welcome.ts`.

---

## Phase A — Cloudflare (inbound forwarding)

**~15 minutes.** Goal: any mail sent to `anything@getlymx.com` forwards to the partner's verified personal email. Cost: free, unlimited inbound.

### A1. Add the domain to Cloudflare

1. Sign up at [cloudflare.com](https://cloudflare.com) (free plan is fine).
2. Click **+ Add a Site** → enter `getlymx.com` → free plan → continue.
3. Cloudflare scans your existing GoDaddy DNS records and offers to import them. Import them. Don't sweat it — you'll review them later.
4. Cloudflare gives you two **nameservers** (e.g. `nina.ns.cloudflare.com` + `marcus.ns.cloudflare.com`). Keep this tab open.

### A2. Swap GoDaddy nameservers to Cloudflare

This is the step you paused on for 2FA before. Same flow:

1. GoDaddy → My Products → `getlymx.com` → DNS → Nameservers → Change.
2. Choose "I'll use my own nameservers" → enter the two Cloudflare nameservers from step A1.4.
3. Save. **Propagation takes 1-24 hours**, usually under 30 minutes. You can keep working in Cloudflare while it propagates.

### A3. Get the Zone ID

1. In Cloudflare, click your `getlymx.com` site.
2. Right sidebar under **API**, copy the **Zone ID**. Looks like a 32-char hex string.
3. **Save this** — it's the value for `CF_ZONE_ID_LYMX` env var later.

### A4. Enable Email Routing

1. Cloudflare dashboard → `getlymx.com` → **Email** tab → **Email Routing** → **Get Started**.
2. Cloudflare auto-adds the required MX + TXT records. Click **Add records** when prompted.
3. Add at least one **destination address** — your personal Gmail (`zhongkennylin@gmail.com`). Cloudflare emails it a verification link; click it.
4. You don't need to add per-partner routes manually — the Edge Function does that via the Cloudflare API.

### A5. Create an API Token

1. Cloudflare profile (top right) → **My Profile** → **API Tokens** → **Create Token**.
2. Use the **Edit zone DNS** template as a starting point.
3. Modify it:
   - **Permissions:** Zone → Email Routing Rules → Edit (add this), and keep Zone → DNS → Edit.
   - **Zone Resources:** Include → Specific zone → `getlymx.com`.
4. Continue → Create Token. **Copy the token immediately** — you only see it once.
5. **Save this** — it's the value for `CF_API_TOKEN_LYMX` env var later.

---

## Phase B — Amazon SES (outbound sending)

**~15 minutes + 24hr wait for production access.** Goal: when a partner replies via Gmail "Send mail as," the SMTP relay accepts and sends as `*@getlymx.com`. Cost: $0.10 per 1,000 emails sent.

### B1. AWS account

If you don't have one, sign up at [aws.amazon.com](https://aws.amazon.com). New accounts get 12 months of free tier — SES isn't on the free tier but the rate is so cheap it doesn't matter.

### B2. Pick a region

Use **us-east-1** (N. Virginia) — it's the SES default and cheapest. **Save this** — the value for `SES_REGION` env var. The SMTP host derives from this: `email-smtp.us-east-1.amazonaws.com`.

### B3. Verify the domain

1. AWS Console → **Simple Email Service** → confirm region is us-east-1 (top right).
2. **Verified identities** → **Create identity** → **Domain** → enter `getlymx.com`.
3. SES gives you 3 **DKIM CNAME records**. Copy them.
4. Add the 3 CNAMEs to Cloudflare DNS (Cloudflare → `getlymx.com` → DNS). For each: type=CNAME, name=copy from SES, target=copy from SES. Set proxy status to **DNS only** (gray cloud, not orange) — DKIM CNAMEs must NOT be proxied.
5. Wait ~5 minutes. SES will mark the domain **Verified**.

### B4. Add SPF and DMARC records

Both go in Cloudflare DNS:

| Type | Name | Value |
|---|---|---|
| TXT | `@` | `v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com ~all` |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@getlymx.com` |

(Note: Cloudflare auto-adds an SPF record when you set up Email Routing — check first. If one exists, *update* it to the value above. Don't add a duplicate.)

### B5. Request production access

By default SES is in **sandbox mode** — you can only send to verified addresses, max 200/day. For real use you need production access:

1. AWS Console → SES → **Account dashboard** → **Request production access**.
2. Fill out the one-paragraph form. Mention: "Loyalty rewards platform sending welcome emails to partners who explicitly signed up. Volume ~50-200/day initially."
3. **Approval typically arrives within 24 hours** by email. Until it does, the partner-provision-email Edge Function will fail in production for any address not pre-verified.

### B6. Generate SMTP credentials

1. AWS SES → **SMTP settings** (left sidebar) → **Create SMTP credentials**.
2. Accept the default IAM user name. Click **Create**.
3. Download or copy the generated **SMTP username** + **SMTP password** (different from your IAM key — these are SES-specific). You only see the password once.
4. **Save these two values** — they're `SES_SMTP_USERNAME` and `SES_SMTP_PASSWORD` env vars.

---

## Phase C — Resend (one-time send for the welcome email)

**~5 minutes.** We use Resend (not SES) for the welcome email because Resend has a much friendlier API for transactional sends. SES does the heavy lifting once partners are sending replies.

### C1. Resend account

1. Sign up at [resend.com](https://resend.com). Free tier is 3,000 emails/month — plenty.
2. **Domains** → **Add Domain** → enter `getlymx.com`.
3. Resend gives you DKIM + SPF records. **CHECK FIRST** — you may already have SPF from B4. If so, you'll need to merge the includes: `v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com include:_spf.resend.com ~all` (one TXT record, all three includes).
4. Add Resend's DKIM CNAME record(s) to Cloudflare DNS, DNS-only (gray cloud).
5. Wait for verification (~5 min).

### C2. API key

1. Resend → **API Keys** → **Create API Key**.
2. Permission: **Sending access** → all domains.
3. Copy the key. **Save it** — `RESEND_API_KEY` env var.

---

## Phase D — Supabase env vars + deploy

**~15 minutes.** Wire all the saved values into Supabase Edge Functions and deploy the 2 functions.

### D1. Set the env vars

Supabase dashboard → **Edge Functions** → **Secrets** (or Settings → Edge Functions secrets, depending on UI version). Add:

| Key | Value | Source |
|---|---|---|
| `CF_ZONE_ID_LYMX` | (from A3) | Cloudflare zone overview |
| `CF_API_TOKEN_LYMX` | (from A5) | Cloudflare API token |
| `SES_REGION` | `us-east-1` | (or your chosen region) |
| `SES_SMTP_USERNAME` | (from B6) | SES SMTP credentials |
| `SES_SMTP_PASSWORD` | (from B6) | SES SMTP credentials |
| `RESEND_API_KEY` | (from C2) | Resend dashboard |
| `EMAIL_FROM` | `LYMX <hello@getlymx.com>` | (literal) |
| `LYMX_DOMAIN` | `getlymx.com` | (literal) |
| `LYMX_SITE_URL` | `https://getlymx.com` | (or current Netlify URL until DNS swap completes) |

### D2. Deploy `partner-provision-email`

Supabase web editor flow (same as the existing 6 Edge Functions):

1. Edge Functions → **Create a new function** → name: `partner-provision-email`.
2. Web editor opens. Replace the boilerplate with the contents of `functions/partner-provision-email/index.ts` from the repo.
3. Click **Deploy**. Wait for "Deployed successfully."
4. **CRITICAL:** the function imports `../_shared/email/templates/partner-welcome.ts`. Supabase's web editor needs you to ALSO upload that file to the function's `_shared/` path. Use the **Upload files** option, or click into `_shared/` and create the file there.
5. Verify the function URL: `https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/partner-provision-email`

### D3. Deploy `partner-revoke-email`

Same flow as D2:
1. Edge Functions → Create → name: `partner-revoke-email`.
2. Paste contents of `functions/partner-revoke-email/index.ts`.
3. Deploy.
4. URL: `https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/partner-revoke-email`

---

## Phase E — Testing

### E1. Smoke test (no real partner)

Create a test partner row directly via SQL editor:

```sql
-- Need an existing auth.users row first; use one of the smoke-test users
-- from Phase 1 testing or create one via business-signup.
-- Then:
insert into public.partners (
    user_id, legal_name, display_name, contact_email, is_founding_25
) values (
    '<some auth.users.id>',
    'Test Partner',
    'Test Partner',
    '<your_personal_email>',
    true
)
returning id;
```

Then call the provision endpoint with the returned `id`:

```bash
curl -X POST https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/partner-provision-email \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"partner_id": "<the-id>"}'
```

Expected: 200 with `{success: true, full_email: "test.partner@getlymx.com", status: "active"}`.

### E2. Verify the chain end-to-end

1. Check your personal email — you should have received the LYMX welcome email within ~30 sec, branded blue/green, with the SMTP setup walkthrough.
2. Send a test email to `test.partner@getlymx.com` from any other email account → should arrive in your personal inbox via Cloudflare forwarding.
3. In Gmail, set up Send-mail-as following the email's instructions. Send a reply from `test.partner@getlymx.com` → should deliver successfully via SES.
4. Check Supabase: `select * from partner_emails where local_part = 'test.partner';` → status should be 'active', cloudflare_route_id populated, smtp_username + smtp_password set, last_error null, onboarding_email_sent_at populated.

### E3. Revoke test

```bash
curl -X POST https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/partner-revoke-email \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"partner_id": "<same-id>"}'
```

Expected: 200 with `{success: true, status: "suspended", cloudflare_route_deleted: true}`. Then send another test email to `test.partner@getlymx.com` → should bounce (route is gone).

---

## Troubleshooting

**Inbound forwarding not working.** Check Cloudflare → Email Routing → Routes. Is the rule for that address listed? Is it enabled? Is your destination Gmail verified?

**Outbound (Gmail Send-mail-as) lands in spam.** SPF record might not include both Cloudflare and SES. Check your TXT `@` record value. New SES accounts also have a "warm-up" period — send small volumes first.

**SES "domain not verified" after 1 hour.** DKIM CNAMEs must be DNS-only (gray cloud) in Cloudflare, not proxied (orange). Toggle each one and wait 5 minutes.

**Edge Function returns 500 on env vars missing.** Open Supabase → Edge Functions → Secrets → confirm every key from D1 is present and non-empty. Re-deploy the function after setting secrets (Supabase doesn't auto-reload running functions).

**Cloudflare API returns 429 rate limit.** Cloudflare allows 1,200 requests per 5 minutes per token. Not a concern unless you're onboarding hundreds of partners in one batch.

**Edge Function `partner-provision-email` returns 502 with "Cloudflare route create failed."** Check the API token's permissions: it needs both **Email Routing Rules: Edit** AND **Zone DNS: Edit** on the `getlymx.com` zone specifically. Re-create the token if uncertain.

---

## What's not covered here (future work)

- **SES SMTP credential rotation.** Currently shared across all partners. To truly revoke an offboarded partner's send capability, you'd need to rotate the IAM user, which would invalidate every active partner. Acceptable for v1; v2 should look at SES Sending Authorization Policies for per-partner gating.
- **Reconciliation job** for `partner_emails` rows stuck in `pending` or `provisioning`. The Edge Function leaves these recoverable via re-call, but a scheduled job to find + retry would be cleaner.
- **Partner-side dashboard view** of their own email status. The schema supports it (RLS lets them SELECT their row, minus the SMTP secrets), but no UI is built yet.
- **Notification email** when status flips to suspended. Currently silent — partner just notices their work email stops working. A simple "your LYMX email has been disabled" message would be kinder.

---

*Document created 2026-05-03. Update when adding new env vars or changing the provisioning flow.*
