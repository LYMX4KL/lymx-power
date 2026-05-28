# LYMX Cold Outreach Setup Runbook (Mailgun on joinlymx.com)

**Concrete one-time steps to wire `joinlymx.com` for outbound cold-prospecting via Mailgun + Cloudflare Email Routing for inbound replies.**

This is the **Cold lane** for LYMX, the mirror of InvestPro's cold-outreach setup. The architecture follows the **Two-Lane Rule** documented in `shared accross projects/COMPANY-EMAIL-ARCHITECTURE.md`. Read that doc first — it explains *why* the cold lane stays separate from the warm `getlymx.com` lane.

**Rewritten 2026-05-27** when the InvestPro outreach platform was mirrored to LYMX. Sister documents:
- `shared accross projects/COMPANY-EMAIL-ARCHITECTURE.md` — architecture rule
- `LYMX Backend/migrations/130_cold_outreach.sql` — DB schema
- `LYMX Power/netlify/functions/dispatch-outreach.js` — Mailgun sender
- `LYMX Power/netlify/functions/outreach-webhook.js` — Mailgun webhook handler
- `LYMX Power/netlify/functions/queue-outreach-campaign.js` — campaign queuer
- `LYMX Power/netlify/functions/import-leads-csv.js` — bulk CSV import
- `LYMX Power/admin-outreach.html` — admin UI

---

## TL;DR

1. **Domain DNS** — confirm `joinlymx.com` lives at Cloudflare with NS records pointing to Cloudflare.
2. **Mailgun** — add `joinlymx.com` to your existing Mailgun account (the same one InvestPro uses is fine — see note in Step 3 about reputation isolation).
3. **DNS records** — paste Mailgun's 3 required records (SPF, DKIM, tracking CNAME) into Cloudflare DNS for `joinlymx.com`.
4. **Cloudflare Email Routing** — enable on `joinlymx.com` and add per-address forward rules to the matching `getlymx.com` address (so replies funnel into the warm lane).
5. **Netlify env vars** — set 4 env vars on the LYMX Netlify site.
6. **Mailgun webhook** — point Mailgun's event webhooks at the LYMX deploy URL.
7. **DB migration** — run `migrations/130_cold_outreach.sql` in the LYMX Supabase SQL editor.
8. **Reputation aging** — wait 7-14 days from Mailgun domain verification before the first real cold send.
9. **Smoke test** — import a 5-row test CSV (your own throwaway addresses), queue a tiny campaign, watch the events flow.

---

## Step 1 — `joinlymx.com` is already at Cloudflare

Per memory `project_lymx_marketing_domains.md`, the LYMX two-domain pattern uses:
- `lymxpower.com` — primary marketing/personal (Kenny's name brand)
- `joinlymx.com` — defensive / cold-outreach destination
- `getlymx.com` — transactional / customer-facing (warm lane, already wired)

If `joinlymx.com` is not already at Cloudflare (DNS-only mode is fine; we don't need the proxy):
1. Cloudflare dashboard → Add Site → enter `joinlymx.com` → Free plan
2. Update registrar's nameservers to Cloudflare's two NS records
3. Wait for "Active" status (5-60 min)
4. Do NOT enable Cloudflare proxy (orange cloud) on the email-related records — proxying breaks SMTP-style flows. Keep them DNS-only (grey cloud).

---

## Step 2 — (Optional) strip any pre-existing email setup on `joinlymx.com`

If you previously experimented with email on `joinlymx.com` (e.g. via Resend or AWS SES), clean it up before adding Mailgun:

1. **Resend** — Dashboard → Domains → if `joinlymx.com` is listed, delete it. (We're moving the cold lane OFF Resend per the Two-Lane Rule — Resend is AWS SES under the hood, which would entangle cold reputation with the warm lane.)
2. **AWS SES** — Console → SES (us-east-1) → Verified identities → if `joinlymx.com` exists, delete it.
3. **DNS** — in Cloudflare for `joinlymx.com`, delete any:
   - `send` subdomain MX/TXT (SES MAIL FROM)
   - `resend._domainkey` TXT
   - SES-issued `*._domainkey` CNAMEs
   - Apex SPF if it includes `amazonses.com`

Leave any existing `_dmarc` TXT alone if it points to a real DMARC mailbox — we'll keep using it.

---

## Step 3 — Add `joinlymx.com` to Mailgun

### 3a. (Decision) Same Mailgun account as InvestPro, or separate?

Per Kenny 2026-05-27: "cold mail mailgun already set up, through netlify" — meaning the existing Mailgun account from InvestPro's cold-outreach setup is the one to use. Adding `joinlymx.com` to it as a second sending domain is supported and cheaper than a second account.

**Reputation note:** Mailgun isolates IP reputation by **sending domain** by default, so InvestPro's reputation hits on `investproleads.com` don't directly drag down `joinlymx.com`. They DO share an account-level reputation signal at Mailgun, which is a softer concern; if you ever do mass cold from one and the account gets flagged, both domains feel it. Acceptable risk for now — split accounts later if it becomes a problem.

### 3b. Add the sending domain

1. Mailgun dashboard → Sending → Domains → Add New Domain → `joinlymx.com`
2. Region: **US** (matches AWS lane region for symmetry)
3. Mailgun generates DNS records — copy them.

### 3c. DNS records to add in Cloudflare for `joinlymx.com`

Add the following to Cloudflare DNS for `joinlymx.com` (replace `<selector>` and `<key>` with the actual values Mailgun shows):

| Type | Name | Value | TTL | Proxy |
|---|---|---|---|---|
| TXT | `@` | `v=spf1 include:mailgun.org ~all` | Auto | DNS only |
| TXT | `<selector>._domainkey` | (long Mailgun-provided DKIM key) | Auto | DNS only |
| CNAME | `email` | `mailgun.org` | Auto | DNS only |

**DO NOT** add Mailgun's MX records. Inbound on `joinlymx.com` goes through Cloudflare Email Routing (Step 4), not Mailgun. Mailgun is outbound-only here.

If a previous `@` SPF TXT exists pointing at something else (e.g. Cloudflare's `_spf.mx.cloudflare.net`), **replace** it with the Mailgun SPF above. Don't have two competing SPF records — that's strict-SPF undefined behavior.

### 3d. Verify

Mailgun → Sending → Domains → `joinlymx.com` → click **Verify DNS settings**. Should flip Verified within 5-15 min.

### 3e. Save the API key

1. Mailgun → Settings → API Security → **Private API key** → copy and save to password manager under "LYMX / Mailgun / Private API Key".
2. Convention: env var name is `MAILGUN_API_KEY_LYMX`.

### 3f. Save the HTTP webhook signing key

1. Mailgun → Settings → API Security → **HTTP webhook signing key** → copy and save.
2. Env var name: `MAILGUN_WEBHOOK_SIGNING_KEY_LYMX`.

---

## Step 4 — Cloudflare Email Routing on `joinlymx.com`

This is the inbound side of the cold lane. Per the Two-Lane Rule, replies to a cold-domain address forward to the matching `getlymx.com` address (warm lane), where Kenny's existing inbound chain takes over.

### 4a. Enable Email Routing

1. Cloudflare → `joinlymx.com` → Email → Email Routing → Get Started
2. Cloudflare auto-adds 3 MX records (`route1.mx.cloudflare.net`, `route2.mx.cloudflare.net`, `route3.mx.cloudflare.net`) + 1 SPF TXT. Approve.

**Conflict warning:** Cloudflare's auto-added SPF TXT will look like:
```
TXT  @   "v=spf1 include:_spf.mx.cloudflare.net ~all"
```

This collides with the Mailgun SPF you added in Step 3c. **Resolve by combining them into a single SPF record:**
```
TXT  @   "v=spf1 include:mailgun.org include:_spf.mx.cloudflare.net ~all"
```

Only one apex SPF TXT allowed. Mailgun's docs cover this combined-include scenario; the order doesn't matter.

### 4b. Add per-address forward rules

For every staff address that will send cold from `joinlymx.com`, create a one-to-one forward rule to the matching `getlymx.com` address (which Kenny's existing inbound chain already handles).

Examples:
- `kenny@joinlymx.com` → `kenny@getlymx.com`
- `hello@joinlymx.com` → `hello@getlymx.com`

Each `getlymx.com` destination must be a verified Cloudflare Email Routing destination on the `getlymx.com` zone. If `kenny@getlymx.com` already routes to Kenny's Gmail via Cloudflare on the getlymx.com zone (the warm lane), the forward chain looks like:
```
kenny@joinlymx.com  →  kenny@getlymx.com  (CF Email Routing on joinlymx.com)
kenny@getlymx.com   →  kenny@gmail.com    (CF Email Routing on getlymx.com — already in place)
```

### 4c. Skip the catch-all

Don't enable a catch-all on `joinlymx.com`. Cold-domain inbound should be **explicit** — if a non-staff address receives mail on the cold domain, it should bounce, not silently forward. That keeps the inbound visibility tight and catches misconfigured campaigns.

---

## Step 5 — Netlify env vars on the LYMX site

Netlify dashboard → site `lymx` → Site settings → Environment variables → add (Site-wide scope):

| Name | Value |
|---|---|
| `MAILGUN_API_KEY_LYMX` | from Step 3e |
| `MAILGUN_DOMAIN_LYMX` | `joinlymx.com` |
| `MAILGUN_WEBHOOK_SIGNING_KEY_LYMX` | from Step 3f |
| `OUTREACH_FROM_DOMAIN` | `joinlymx.com` |
| `OUTREACH_REPLY_TO_DOMAIN` | `joinlymx.com` |

Already present and reused (don't duplicate):
- `SUPABASE_URL` — points at LYMX Supabase (apffootxzfwmtyjlnteo)
- `SUPABASE_SERVICE_ROLE_KEY`
- `URL` — auto-set by Netlify, used in the unsubscribe link

Trigger a deploy after adding env vars so the functions pick them up.

---

## Step 6 — Point Mailgun webhooks at the LYMX deploy

In Mailgun → Sending → Webhooks → for the `joinlymx.com` domain, click each event and set the URL:

```
https://lymx.netlify.app/.netlify/functions/outreach-webhook
```

(Or `https://getlymx.com/.netlify/functions/outreach-webhook` once the custom domain is wired.)

**Events to enable:**
- delivered
- opened (optional but recommended for engagement metrics)
- clicked
- permanent_fail
- temporary_fail
- complained
- unsubscribed

The handler treats `accepted` and `delivered` interchangeably for status; you can enable `accepted` too but it's noisy.

---

## Step 7 — Run the DB migration

In the LYMX Supabase SQL editor (project `apffootxzfwmtyjlnteo`):

1. Open `LYMX Backend/migrations/130_cold_outreach.sql`
2. Paste the entire file into the editor
3. Run

The migration is wrapped in `BEGIN` / `COMMIT` and uses named dollar-quote tags so multiple `DO $$ ... $$` blocks parse correctly. The final `SELECT` returns row counts for the 7 new tables (all zeros on a fresh install) — that's your verification that everything was created.

---

## Step 8 — Reputation aging (mandatory)

Mailgun's docs are blunt: **never blast a freshly verified cold domain on day one**. Plan to do nothing on `joinlymx.com` for 7-14 days from the moment Mailgun shows the domain Verified.

What "nothing" means specifically:
- Don't send any cold campaigns.
- Don't send any test mail to throwaway addresses you've never written to before.
- Personal mail from `kenny@joinlymx.com` to one or two warm contacts (people who would respond) is fine — Mailgun will see legitimate traffic, which actually helps the warm-up.
- If you have a smoke test you want to run (Step 9 below), do it AFTER the aging window or use Mailgun's sandbox domain for the pre-warm-up tests.

---

## Step 9 — Smoke test (after aging window)

Once the aging window is complete:

1. **Build a 5-row test CSV** with addresses you control (your Gmail, your iCloud, a partner's Gmail they agreed to test with). NEVER use scraped addresses for the smoke test — they may be spam traps.
   ```csv
   email,first_name,last_name,business_name,business_city,business_state
   you+test1@gmail.com,Test,One,Tester's BBQ,Las Vegas,NV
   you+test2@gmail.com,Test,Two,Tester's Salon,Las Vegas,NV
   ...
   ```

2. **Open `admin-outreach.html`** as admin.

3. **Import CSV** → "Create new list during import" → name "Smoke test 2026-05-XX" → audience "business_prospect" → paste CSV → click **Dry-run** first (verify it parses cleanly) → then **Import**.

4. **New campaign** → name "Smoke test first touch" → pick the smoke-test list → audience business_prospect → From `kenny@joinlymx.com` / "Kenny Lin · LYMX" → Reply-To `kenny@joinlymx.com` → subject like `"Smoke test — {first_name}, ignore please"` → tiny HTML body → daily cap 10, suppression 90 → **Save & queue all**.

5. **Wait up to 10 minutes** for the dispatch cron to fire (or hit `/.netlify/functions/dispatch-outreach` manually with a `POST`). Mailgun events should appear in:
   - Mailgun dashboard → Sending → Logs (immediate, includes Delivered/Open/Click events)
   - `outreach_sends` rows updated to `status='delivered'` shortly after
   - `outreach_campaigns.total_sent` / `total_delivered` counters increment

6. **Click the unsubscribe link** in one of the test emails → confirm a row appears in `outreach_unsubscribes` and the matching `outreach_leads.status` flips to `unsubscribed`.

7. **Reply to a cold email from one of the test inboxes** → confirm the reply lands in the matching `getlymx.com` address (Kenny's Gmail).

If all 4 checks pass, the cold lane is fully wired.

---

## Step 10 — Operational notes

### Daily caps
Each campaign has a `daily_send_cap` (default 250). Dispatch counts cumulative sends since UTC midnight per campaign. If you queue 1,000 sends with cap 250, the dispatcher sends 250/day for 4 days, then marks the campaign `sent` once the queue is drained.

### Per-second throttle
Each campaign has `per_second_cap` (default 1). The dispatcher sleeps `max(100ms, 1000/per_second_cap)` between sends. Bump this up gradually (3, 5, 10) only after the domain has been warm for 30+ days with no bounce/complaint spikes.

### Suppression window
`resend_suppression_days` (default 90) prevents the same lead from receiving another campaign within N days. Tunable per campaign — short follow-up sequences can use 7 or 14 days.

### Webhook idempotency
The webhook handler updates by `provider_message_id`. If Mailgun retries an event (it does — generously), the second update is a no-op for status transitions but bumps `opened_count`/`clicked_count` again. Acceptable; the counters are best-effort engagement signals, not exact-once.

### What to do when a campaign goes wrong
1. Set the campaign's `status` to `paused` (UPDATE in SQL editor or via the admin UI when "Pause" is added).
2. Dispatch will skip paused campaigns on its next 10-minute tick.
3. Queued sends stay queued; you can either delete them (`DELETE FROM outreach_sends WHERE campaign_id = ? AND status = 'queued'`) or resume later.

### Compliance
Every email gets:
- `List-Unsubscribe` header (one-click per RFC 8058)
- An unsubscribe link in the footer (auto-appended if the body template doesn't include `{unsubscribe_url}`)
- A LYMX postal address (add to your body template) — required by CAN-SPAM
- An accurate From: identifying LYMX as the sender

`outreach_unsubscribes` is the append-only CAN-SPAM record. `outreach_bounces` is the deliverability audit log. Neither should be DELETEd (audit triggers on them only catch UPDATE/DELETE so accidental ops surface).

---

## Step 11 — Where things live (file map)

```
LYMX Backend/
├── migrations/130_cold_outreach.sql       ← run once in Supabase
└── LYMX-COLD-OUTREACH-SETUP.md            ← this doc

LYMX Power/
├── admin-outreach.html                    ← admin UI (lists + campaigns)
├── netlify.toml                           ← [functions] block points at netlify/functions/
└── netlify/functions/
    ├── dispatch-outreach.js               ← Mailgun sender, runs every 10 min
    ├── outreach-webhook.js                ← Mailgun event handler
    ├── queue-outreach-campaign.js         ← POSTed by admin UI on "Save & queue"
    └── import-leads-csv.js                ← POSTed by admin UI on CSV upload

shared accross projects/
└── COMPANY-EMAIL-ARCHITECTURE.md          ← Two-Lane Rule architecture
```

---

## Step 12 — Future work (not blocking)

- **Drip sequences** — current schema has campaigns as single-touch. To add multi-step follow-up, either spawn a follow-up campaign on a delay (cron + lookup) or extend `outreach_campaigns` with a `parent_campaign_id` + `step_offset_days` field.
- **A/B subject lines** — extend campaigns with a JSON array of subject variants + a column on `outreach_sends` recording which variant was sent. Compute open-rate-per-variant from `opened_count`.
- **Personalization beyond `{first_name}` etc.** — the renderTemplate function is dumb substitution; for AI-personalized first lines, generate them at queue time (in `queue-outreach-campaign.js`) and store the rendered text on the `outreach_sends` row.
- **Lead enrichment** — when a CSV row only has `email`, look up `business_name` / `business_city` via a public business directory before queuing.
- **Reply detection** — track the inbound side: when a reply lands in `kenny@getlymx.com` referencing a `X-LYMX-Send-Id` header (from the cold-side outbound), mark the corresponding `outreach_sends` row as "replied" and flip the lead to a "warm" status. Then queue a different (transactional, getlymx.com via Resend) follow-up.
- **Admin UI enhancements** — campaign edit, pause/resume buttons, send-queue dashboard with per-send drill-down, lead detail view with full send history, suppression manager UI.

---

**End of runbook.**
