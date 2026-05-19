# getlymx.com — DNS migration to Cloudflare (2026-05-07)

> **Goal:** Move getlymx.com DNS from NS1 (Netlify-managed) to Cloudflare WITHOUT taking the live site down. Required because the partner-email Edge Function uses Cloudflare's Email Routing API.

## Pre-migration state — confirmed

- **Registrar:** GoDaddy (renews Jan 27, 2027 at $22.99/yr)
- **Current nameservers:** `dns1.p04.nsone.net`, `dns2.p04.nsone.net`, `dns3.p04.nsone.net`, `dns4.p04.nsone.net` (Netlify-managed via NS1)
- **Current DNS records (only 2):**
  - `getlymx.com` (apex) → NETLIFY → `lymx.netlify.app`
  - `www.getlymx.com` → NETLIFY → `lymx.netlify.app`
- **Site state:** LIVE at https://getlymx.com (Netlify SSL active)

## Step 1 — Add getlymx.com to Cloudflare

1. Go to https://dash.cloudflare.com → **+ Add a Site**
2. Enter `getlymx.com` → Continue
3. Choose **Free** plan → Continue
4. Cloudflare will scan NS1 for existing records. **NS1 likely refuses zone transfer**, so 0 records will import. That's fine — we'll add them manually.

## Step 2 — Add the 2 Netlify-pointing records BEFORE swapping nameservers

In Cloudflare DNS → Records → **Add record** (twice):

| Type | Name | Target | Proxy status | TTL |
|---|---|---|---|---|
| CNAME | `@` (apex) | `lymx.netlify.app` | **DNS only** (gray cloud) | Auto |
| CNAME | `www` | `lymx.netlify.app` | **DNS only** (gray cloud) | Auto |

**IMPORTANT — proxy must be OFF (gray cloud) on both.** Cloudflare's proxy will conflict with Netlify's own SSL/edge. Once site is stable on Cloudflare, you could experiment with turning proxy ON, but start gray.

Cloudflare automatically flattens the apex CNAME to A records at query time — this is supported on the Free plan.

## Step 3 — Copy Cloudflare's nameservers

After adding the 2 records, scroll up. Cloudflare shows you 2 nameservers it assigned to your zone, like:
- `someone.ns.cloudflare.com`
- `someone-else.ns.cloudflare.com`

Copy both exact strings.

## Step 4 — Change nameservers at GoDaddy

1. Go to https://account.godaddy.com → Sign in
2. My Products → getlymx.com → **Manage Domain**
3. **DNS** tab → **Nameservers** subtab
4. Click **Change Nameservers**
5. Choose "I'll use my own nameservers"
6. Replace the 4 NS1 nameservers with the 2 Cloudflare nameservers
7. Save

## Step 5 — Wait for propagation

- Usually 5–30 minutes; sometimes up to a few hours
- Watch Cloudflare dashboard for getlymx.com — when it flips from "Pending nameserver update" to **"Active"**, you're done
- During the wait, https://getlymx.com may briefly resolve to either old or new nameservers, but BOTH point to Netlify, so the site stays up

## Step 6 — Tell me "active"

Once Cloudflare shows getlymx.com as Active, message me and I'll continue with:
- Cloudflare Email Routing (catch-all + per-partner forwarding for the Edge Function)
- AWS SES verified identity for getlymx.com (3 DKIM CNAMEs + MAIL FROM MX/SPF)
- Resend domain add (4 records)
- Migration 005 in Supabase
- Set 9 Edge Function secrets in Supabase
- Deploy 3 partner-email Edge Functions
- Smoke test end-to-end

## What's NOT happening tonight

- **Registration transfer to Cloudflare** — DEFER. We're only changing nameservers tonight, not the registrar. The registration stays at GoDaddy until later. Transfers take 5-7 days, but they don't affect DNS, so no rush.

## Rollback if anything goes wrong

If after the nameserver swap the site is broken (https://getlymx.com doesn't load):
1. Go back to GoDaddy → DNS → Nameservers
2. Change nameservers BACK to: `dns1.p04.nsone.net`, `dns2.p04.nsone.net`, `dns3.p04.nsone.net`, `dns4.p04.nsone.net`
3. Wait ~5 min
4. Site will be back on NS1; troubleshoot Cloudflare config, then retry

That's the panic-revert path. Save it just in case.
