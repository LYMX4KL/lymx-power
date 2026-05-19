# LYMX Power — Full Test Plan for Dave

**Version:** 1.0
**Date issued:** 2026-05-07
**Issued by:** Kenny (LYMX4KL)
**Tester:** Dave (davespencerbacay)
**Tester access:** GitHub (lymx-power), Supabase (apffootxzfwmtyjlnteo), Netlify (team lymx4kl), AWS (Fellora 009846316105)

---

## Why this doc exists

We're approaching launch. Before we open the floodgates to real customers, partners, and businesses, every flow needs at least one set of fresh eyes that didn't write the code. That's you.

The build has happened in fast iterative cycles. Some pages were authored, polished, and re-polished without anyone ever clicking through them in a clean browser session. That's the gap we're closing. Your job is to **find what's broken, what's confusing, what's missing, and what's just plain wrong** — and write it down precisely enough that the fix is obvious.

Two outputs are expected from this round:

1. **A completed findings document** (`TEST-FINDINGS-FROM-DAVE.md`) — using the template at the end of this doc.
2. **Issues filed in GitHub** for each P0/P1 finding (`LYMX4KL/lymx-power` repo, Issues tab) — one issue per finding, linked back to the relevant test ID in the findings doc.

Total expected effort: 8-16 hours, spread over 2-4 days.

---

## Scope at a glance

You're testing four areas:

| Area | What | Where | Test IDs |
|---|---|---|---|
| A. Public website | 221 HTML pages, every CTA, every link, every form | `https://getlymx.com` | A.1 – A.~50 |
| B. Form A intake | Storefront + self-employed business sign-up | `https://getlymx.com/biz-signup.html` | B.1 – B.20 |
| C. Backend Edge Functions | curl-level testing of all deployed functions | Supabase project `apffootxzfwmtyjlnteo` | C.1 – C.~30 |
| D. Square POS integration | OAuth flow + webhook handler (if deployed) | Same Supabase project | D.1 – D.~10 |
| E. Cross-cutting | Mobile, accessibility, performance, security | Whole site + APIs | E.1 – E.~15 |

**Out of scope for this round:**

- Partner email feature (Edge Functions exist but are not yet deployed; DNS migration in progress 2026-05-07; will be tested in a future round once getlymx.com is on Cloudflare and SES + Resend records are live)
- Form B intake (deferred, blocked on InvestPro)
- Share-to-earn rewards (still in design phase, not built)

If you find bugs in out-of-scope areas while testing, log them — just mark severity P3 and we'll triage later.

---

## Pre-test setup

### 1. Tools you'll need

- A modern browser. **All three of:** Chrome (latest), Safari (latest on macOS or iOS), Firefox (latest)
- A mobile device or browser dev-tools mobile emulator (iPhone SE 375×667 minimum, plus a tablet width like iPad 768×1024)
- `curl` (preinstalled on macOS / Linux; on Windows use Git Bash or WSL)
- `jq` for parsing JSON responses (`brew install jq` / `apt install jq`)
- A Supabase SQL Editor session (in dashboard) for verifying database state after API calls
- The repo cloned locally: `git clone git@github.com:LYMX4KL/lymx-power.git && cd lymx-power && git checkout main`

### 2. Credentials you'll need

Get these from Kenny (do NOT paste into emails or Slack — use 1Password share, encrypted message, or in-person):

```
SUPABASE_URL=https://apffootxzfwmtyjlnteo.supabase.co
SUPABASE_ANON_KEY=ey...                 # safe-ish, browser-callable
SUPABASE_SERVICE_ROLE_KEY=ey...         # server-side only, full power
SUPABASE_DB_PASSWORD=...                 # for direct Postgres access
NETLIFY_TEAM=lymx4kl                     # team URL slug
AWS_ACCOUNT=Fellora (009846316105)       # SES + IAM live here
```

Save these to a `.env.local` file at the repo root, never commit it. The repo's `.gitignore` already covers `.env*`.

### 3. Test data conventions

When you create test entities (businesses, partners, customers), use these patterns so we can clean them up later with one query:

- Test emails: `dave-test-{timestamp}@smoketest.dev` (the `@smoketest.dev` suffix is our cleanup signal)
- Test legal names: prefix with `[TEST]` — e.g., `[TEST] Smoke Cafe LLC`
- Test phones: use the `+1-702-555-01XX` range (NV reserved-for-fiction numbers)
- Test ZIPs: `89101` (Las Vegas)

After your testing is done, run this cleanup SQL (have Kenny verify before you run it on prod):

```sql
-- Preview what will be deleted
select id, email, created_at from auth.users
where email like '%@smoketest.dev'
   or email like 'dave-test-%';
```

### 4. Environment to test against

**Default:** test against the live site at `https://getlymx.com` and the live Supabase project.

This is intentional — we don't have a separate staging environment yet. The launch isn't public yet (no marketing has gone out, no real partners have signed up), so live = staging for this round. Just use the test data conventions above to keep your data sequestered.

If at any point you find something destructive or scary, **STOP** and message Kenny before continuing.

---

## Section A — Public website testing

The site at `https://getlymx.com` has roughly 221 HTML pages organized into the categories below. For EACH page, run the **Standard Page Checklist** below. Then for category-specific pages, run the additional checks listed under each category.

### Standard Page Checklist (apply to every page)

For each page, verify:

| # | Check | Pass criteria |
|---|---|---|
| 1 | Page loads without console errors | Open DevTools Console; no red errors |
| 2 | All images load (no broken `🖼️ alt-text` placeholders) | Visual check + DevTools Network tab |
| 3 | All internal links point to existing pages (no 404s) | Click each one, confirm 200 |
| 4 | All external links open in new tab and have `rel="noopener"` | DevTools Elements inspect |
| 5 | Mobile viewport (375px wide) renders without horizontal scroll | Resize browser or use device emulator |
| 6 | Tablet viewport (768px wide) renders cleanly | Same |
| 7 | Desktop viewport (1280px wide) renders cleanly | Same |
| 8 | Text is legible at every viewport (no font shrinking past 14px body, 12px caption) | Visual check |
| 9 | All CTAs (buttons, sign-up forms) are visible above the fold OR clearly findable | Visual check |
| 10 | Page title (`<title>`) matches the page content | View page source / DevTools |
| 11 | Meta description is present (`<meta name="description">`) | View page source |
| 12 | Open Graph tags present (`og:title`, `og:description`, `og:image`) for social sharing | View page source |
| 13 | No "lorem ipsum" or "TODO" or placeholder text anywhere visible | Ctrl-F the page source |

For any FAIL, note the page URL, viewport, browser, and exact symptom in the findings doc.

### Categories to test

> Tip: scroll the entire site once with the sitemap in `lymx.netlify.app/sitemap.xml` if available, or use Netlify's deploy log to enumerate every published HTML file. As of this writing the site has ~221 pages — too many for a single click-through, so focus per category and mark coverage in your findings.

#### A.1 Homepage and top-level navigation
- `index.html` (homepage)
- `about.html`
- `why-lymx.html` / value-prop pages
- `pricing.html` (if present)
- Header and footer navigation works on every page

**Specific checks:**
- Hero CTA goes where it claims (e.g., "Sign up your business" → `biz-signup.html`)
- Footer links are not broken (privacy, terms, contact)
- Logo in top-left links back to homepage from every page

#### A.2 Business-facing pages
- `for-business.html` or similar landing
- `business-signup.html` or `biz-signup.html`
- Pricing / signup explainer pages
- Admin/owner-facing tools — `admin-businesses.html`, `admin-tickets.html`, `admin-investors.html`, `catering` pages

**Specific checks:**
- Sign-up flow CTA reaches `biz-signup.html` (covered in Section B)
- Admin pages either require auth (preferred) OR display a "demo mode" banner
- Pricing math is consistent: $850 sign-up + 3-month free + $199/mo (per current memory; verify against site copy)
- 80% rule on redemption is mentioned somewhere in business-facing copy
- LYMX issuance rate (5 LYMX per $1) is stated correctly

#### A.3 Partner-facing pages
- `for-partner.html` / `partners.html` / `partner-program.html`
- Founding 25 campaign pages — `founding-25.html`, `founding-25-day-1-playbook.md` rendered version, etc.
- Commission structure explainer — `partner-playbook.html`
- Partner sign-up flow

**Specific checks:**
- Generation tree commission percentages are consistent (9% direct / 3% G1 / 2% G2 / 1% G3)
- Founding 25 perks are explained correctly: $25 sign-up fee waived permanently, $1,000 speed bonus, etc.
- Distinction between Production (own businesses) vs G1/G2/G3 (downline partners) is clear and never conflated
- Hard rule: nowhere on the site should LYMX be called "currency", "money", "crypto", or similar — only "rewards", "credits", "loyalty rewards", "points"

#### A.4 Customer-facing pages
- `for-customers.html` / `customers.html`
- How LYMX works (earn / redeem / transfer)
- FAQ for customers

**Specific checks:**
- Transfer rule is correctly stated: LYMX can transfer between customers AT THE SAME BUSINESS (not across businesses)
- Redemption cap (80%) is stated
- Wallet concept (per-customer-per-business) is explained without jargon

#### A.5 Founding 25 campaign pages
- `campaign-founding-25.html` and any related landing pages
- `founder-dinner-invite.html` (event-specific)
- `friends-family-outreach.html`

**Specific checks:**
- All campaign deadlines and dates are still valid (or marked "expired" if past)
- The 5-Direct-activations rule for qualifying as Founding 25 is correctly stated
- Cooperative training requirement (ongoing to keep grandfathered perks) is mentioned
- No promises of guaranteed income (legal compliance)

#### A.6 Legal & compliance pages
- `privacy.html`
- `terms.html`
- `disclaimer.html` if present
- Any "earnings disclaimer" pages (important for partner program)

**Specific checks:**
- Privacy policy mentions data we collect (email, phone, transaction history)
- Terms include the cap on commission generations + Founding 25 grandfathering rules
- Earnings disclaimer is present on every partner-facing page (footer link minimum)
- Contact info is correct (email + phone)

#### A.7 Forms (other than Form A)
- Newsletter signup
- Contact form
- Calendly embed (if booking calls)
- Any other lead-capture forms

**Specific checks:**
- Form submits without error (use a test email)
- Confirmation message appears or you're redirected to a success page
- The submitted data actually arrives somewhere (CRM, email, Supabase) — verify with Kenny's auth into wherever it's supposed to land

#### A.8 Edge cases
- 404 page (visit `https://getlymx.com/this-page-does-not-exist.html` — does it serve a styled 404?)
- HTTPS forced redirect (visit `http://getlymx.com` — should redirect to HTTPS)
- WWW handling (visit `https://www.getlymx.com` — should serve the same site or 301 to apex)

---

## Section B — Form A signup testing

Form A is the business intake form, with two modes:
- **Mode 1: Storefront** — has a physical location (cafe, salon, store)
- **Mode 3: Self-employed** — services-based (consulting, freelance, mobile)

URL: `https://getlymx.com/biz-signup.html` (verify exact path — could be `business-signup.html`).

There's already a smoke-test script at `LYMX Backend/smoke-tests/form-a-signup.sh`. Run it FIRST as a baseline:

```bash
cd LYMX\ Backend
export SUPABASE_URL="https://apffootxzfwmtyjlnteo.supabase.co"
export SUPABASE_ANON_KEY="<anon key>"
bash smoke-tests/form-a-signup.sh
```

Expected: all 3 tests pass with green checkmarks. If they don't, that's a P0 — flag immediately.

### B.1 — Mode 1 storefront, happy path (UI)
1. Navigate to the form page from the homepage CTA — does it work?
2. Select "Storefront / has a physical location"
3. Fill in valid data (use test conventions above)
4. Submit
5. Verify: success message displays, redirected to dashboard or "thank you" page

**In Supabase, verify:**
```sql
select * from auth.users where email = '<your-test-email>';
select * from businesses where contact_email = '<your-contact-email>';
select * from business_locations where business_id = '<the new biz id>';
select * from business_subscriptions where business_id = '<the new biz id>';
```
Expected: 1 row each, business_subscriptions shows trial_end ~3 months from today.

### B.2 — Mode 3 self-employed, happy path (UI)
Same flow but Mode 3.
- Verify the form swaps to ask for service-area instead of street/city/state/zip
- Verify the form lets you add multiple services (each with name, price, LYMX-per-booking)
- Submit with 3 services
- In DB: verify `business_locations` row has `service_area` populated, and `services` table has 3 rows linked to the business

### B.3 — Validation: Mode 1 with missing required fields
Try submitting Mode 1 with each of these missing/invalid:
- Empty owner email → should reject with clear error
- Owner password less than 10 chars → reject
- Empty legal name → reject
- Phone number malformed → reject
- City empty → reject
- ZIP not 5 digits → reject
- Issuance rate < 1 or > 100 → reject

### B.4 — Validation: Mode 3 with missing services
- Submit with services array empty → should 400 (verified by smoke-test #3)
- Submit with one service with negative price → reject
- Submit with one service with empty name → reject

### B.5 — Idempotency / dupe handling
- Submit Mode 1 with an email that's ALREADY an auth user → expected: 409 Conflict or similar, with clear "email already in use" message
- Submit twice rapidly with same payload (network race) → should result in only ONE auth user, ONE business

### B.6 — Partner attribution
The form may have a `?ref=PARTNERID` query param mechanism for attributing the signup to a referring partner.
1. Navigate to `biz-signup.html?ref=<some-known-partner-id>`
2. Submit a successful signup
3. In DB: verify `partner_commissions` has a row crediting that partner with the $500 sign-up bonus
4. Edge case: invalid partner ID → does the form reject, or silently accept and skip attribution? (Either is OK; document which it does.)

### B.7 — Cross-browser
Run B.1 and B.2 in Chrome, Safari, Firefox. Note any browser-specific failures.

### B.8 — Mobile
Run B.1 and B.2 on iPhone-sized viewport. Note any layout breaks (overflowing fields, hidden submit button, broken form labels).

### B.9 — Accessibility
- Tab through the form with keyboard only — can you reach every field and submit?
- Each input has a `<label>` (DevTools Elements check)
- Error messages are announced to screen readers (`aria-live` regions)

### B.10 — End-to-end: signup → dashboard
After a successful signup, where does the user land? Is there a dashboard to log into? Can they log in with the email + password they just created? If yes, does the dashboard show their newly-created business?

---

## Section C — Backend Edge Functions

For each endpoint, verify:
- Documented happy-path returns the documented success status
- Documented auth model is enforced (e.g., user JWT required → reject service role and vice versa where appropriate)
- Common error paths return useful error JSON, not a generic 500
- Idempotency works where claimed
- Audit trail is written to the database

The repo's `LYMX Backend/README.md` has a per-endpoint summary at `## Endpoints at a glance`. Each `functions/*/index.ts` has a header comment block with the full request/response contract.

### C.1 – C.5 — `business-signup`
Already covered by Section B. If you want to drive this with curl directly, see `smoke-tests/form-a-signup.sh` for a working invocation.

### C.6 — `customer-wallet-create`
**Auth:** User JWT.
**Goal:** Create a wallet for the calling customer at a given business.

```bash
# Get a user JWT first by signing in (use a test customer)
USER_JWT=$(curl -sS -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"customer-test@smoketest.dev","password":"testpass1234!"}' \
  | jq -r .access_token)

# Call the endpoint
curl -sS -X POST "$SUPABASE_URL/functions/v1/customer-wallet-create" \
  -H "Authorization: Bearer $USER_JWT" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "business_id": "<some existing biz uuid>",
    "phone": "+17025550199",
    "display_name": "Test Customer"
  }' | jq .
```

**Verify:**
- Status 200 or 201 with wallet UUID in body
- Calling twice → returns the SAME wallet (idempotent)
- Calling without auth → 401
- Calling with non-existent business_id → 404 or 400 with clear error

### C.7 — `issuance`
**Auth:** Biz owner OR service role.
**Goal:** Mint LYMX from a $ purchase.

Test as biz owner JWT, then as service role.

```bash
SERVICE_KEY="$SUPABASE_SERVICE_ROLE_KEY"
curl -sS -X POST "$SUPABASE_URL/functions/v1/issuance" \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "business_id": "<biz uuid>",
    "wallet_id":   "<wallet uuid>",
    "usd_amount":  20.00,
    "pos_external_id": "test-receipt-001"
  }' | jq .
```

**Verify:**
- Returns transaction with `lymx_issued = floor(20 * 5) = 100`
- Wallet balance increases by 100
- Calling AGAIN with the same `pos_external_id` → returns the SAME transaction, doesn't double-issue
- Calling without auth → 401
- Calling as a customer JWT (not biz owner) → 403

### C.8 — `redemption`
**Auth:** Biz owner OR service role.
**Goal:** Customer pays with LYMX up to 80% of the total.

```bash
curl -sS -X POST "$SUPABASE_URL/functions/v1/redemption" \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "business_id": "<biz uuid>",
    "wallet_id":   "<wallet uuid>",
    "usd_total":   25.00,
    "lymx_redeemed": 1000,
    "pos_external_id": "test-receipt-002"
  }' | jq .
```

**Verify:**
- Returns transaction with `usd_paid = lymx_redeemed / (rate * 100)` for default rate of 5: `1000 / 500 = $2.00`
- Wallet balance decreases by 1000
- Trying to redeem MORE than 80% of the total → rejects with "exceeds 80% cap" error
- Idempotent on `pos_external_id`

### C.9 — `transfer`
**Auth:** Customer JWT (sender's).
**Goal:** Send LYMX from customer A to customer B AT THE SAME BUSINESS.

**Verify:**
- Two paired transactions created (`transfer_out` + `transfer_in`)
- Both transactions linked via `paired_transaction_id`
- Balances update on both wallets
- Trying to send to a customer NOT at the same business → rejects
- Receiver wallet auto-provisioned if missing
- Auth: only sender's JWT works (not the receiver's)

### C.10 — `settlement`
**Auth:** Service role only.
**Goal:** Bundle weekly partner_commissions into payable settlements.

```bash
curl -sS -X POST "$SUPABASE_URL/functions/v1/settlement" \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "period_start": "2026-04-28",
    "period_end":   "2026-05-04",
    "dry_run": true
  }' | jq .
```

**Verify:**
- `dry_run: true` reports what WOULD be settled but doesn't write anything
- `dry_run: false` writes settlement rows (one per partner)
- Re-running for the same period only picks up still-unsettled commissions (no double-settlement)
- Only service role can call (user JWT → 403)

### C.11–C.13 — Partner email functions (out of scope this round)
- `partner-provision-email`, `partner-revoke-email`, `partner-acknowledge-email`
- These are NOT yet deployed (DNS migration pending). Do not attempt to test. Calling them will return 404 or 500.

### C.14 — Auth pattern verification
A subtle bug pattern: Supabase's Edge Function gateway sometimes re-stamps the `Authorization` header. The codebase uses a **JWT role-claim decode** instead of literal token compare (see `LYMX Backend/README.md` "The auth pattern lesson").

**For each endpoint, verify:**
- Calling with a literal anon key → rejected unless explicitly public
- Calling with a service role JWT → accepted where service-role is allowed
- Calling with a user JWT whose `payload.role === "authenticated"` → accepted only on user-auth endpoints

### C.15 — Sensitive data column REVOKE
The schema uses **column-level REVOKE** for sensitive columns (Square OAuth tokens, SES SMTP creds). Even a biz owner running `select *` should get a permission error on those columns.

**Verify:**
- As a biz-owner JWT, query `select * from square_integrations` via Supabase REST API or PostgREST → expect column permission error
- Same query as service role → returns the columns

---

## Section D — Square POS integration

If the Square endpoints are deployed, test:

### D.1 — `square-oauth-init`
- Hitting the endpoint redirects the user to Square's OAuth consent screen with the correct `client_id` and `redirect_uri`
- The state parameter is generated and stored (for CSRF protection)

### D.2 — `square-oauth-callback`
- Hitting the callback with a valid Square authorization code → exchanges it for tokens, writes a `square_integrations` row
- Hitting with an invalid code → returns an error, no row written
- Hitting with a state that doesn't match → rejected (CSRF guard)

### D.3 — `square-webhook`
- POSTing a valid Square webhook payload (with valid HMAC signature) → returns 200, writes `square_webhook_events` row
- POSTing with an invalid signature → 401
- POSTing the SAME `event_id` twice → returns the same response, doesn't double-process (idempotency)

### D.4 — Cleanup
- Square sandbox test merchant connected and disconnected cleanly

If Square endpoints are NOT deployed, skip this section and note "deferred — endpoints not deployed."

---

## Section E — Cross-cutting concerns

### E.1 — Mobile end-to-end flow
On a real iPhone or Android (not just emulator):
1. Visit getlymx.com homepage
2. Tap the business signup CTA
3. Complete Form A
4. Land on whatever the post-signup destination is

Note: any thumb-unfriendly tap targets, missing autocomplete on form fields (`autocomplete="email"` etc.), keyboard-blocked-by-keyboard situations, etc.

### E.2 — Performance
Run [PageSpeed Insights](https://pagespeed.web.dev/) on:
- Homepage
- Form A signup page
- Founding 25 campaign page

Pass criteria: Lighthouse Performance score ≥ 80 on mobile, ≥ 90 on desktop. If not met, note which metric is the bottleneck (LCP, CLS, etc.) so we can prioritize.

### E.3 — Accessibility
Run a quick audit with browser DevTools → Lighthouse → Accessibility. Pass: ≥ 90.

Manual checks:
- All images have alt text
- Color contrast meets WCAG AA (4.5:1 for body text)
- Tab order is logical on every form
- Focus indicators are visible

### E.4 — Security spot-checks (light, not pen-test)
- Open DevTools Network tab during Form A signup. Confirm sensitive data (passwords) is NOT logged in the request URL or query params (must be in request body over HTTPS only)
- Confirm there are no API keys, service-role JWTs, or Supabase URLs hardcoded in client-side JS (View Source → Ctrl-F for `service_role`, `eyJhbGc`, etc.)
- Confirm CORS headers on Edge Functions don't allow `*` for sensitive endpoints

### E.5 — Copy / brand consistency sweep
Open `find . -name "*.html" -exec grep -l "currency\|money\|crypto" {} \;` in the repo locally and confirm none of those words appear describing LYMX (allowed in unrelated contexts like privacy policy, of course).

Hard rule from Kenny: LYMX is "rewards" / "loyalty rewards" / "credits" / "points" — never the C-words.

Also grep for: `lorem`, `ipsum`, `TODO`, `FIXME`, `XXX`, `placeholder`, `Hello World`. None should appear in published HTML.

### E.6 — Link health crawler
Run a link checker against `https://getlymx.com`. There are free tools — e.g., [linkchecker](https://github.com/linkchecker/linkchecker) — `linkchecker https://getlymx.com`. Report any 4xx or 5xx links.

### E.7 — Forms anti-spam
Do the public forms have any spam protection (honeypot field, CAPTCHA, rate limiting)? If not, that's a finding — log it as P2.

---

## Severity definitions

When you log findings, use these levels:

| Level | Meaning | Example |
|---|---|---|
| **P0** | Blocks launch. Site or critical flow is broken. | Homepage doesn't load, signup form 500s, payment math is wrong |
| **P1** | Important. Should fix before launch but not blocking by itself. | Mobile layout broken on a key page, partner attribution silently fails, missing 80% rule explanation |
| **P2** | Nice to fix. Not user-facing or has a workaround. | Console warning, slow page load, missing alt-text on a decorative image |
| **P3** | Polish / future. Doesn't affect launch. | Out-of-scope finding, minor copy improvement, "would be nice if…" |

---

## Bug reporting template

For each finding, file a GitHub issue using this template. Also list the same finding in your findings document.

```markdown
**Test ID:** [e.g., A.3.5 — Partner-facing pages, generation tree page]
**Severity:** P0 / P1 / P2 / P3
**Browser:** Chrome 130 / Safari 17 / Firefox 130 / Mobile Safari iOS 18 / etc.
**Viewport:** 375x667 / 768x1024 / 1280x800 / etc.
**URL:** https://getlymx.com/...

### Steps to reproduce
1. ...
2. ...
3. ...

### Expected
What should happen.

### Actual
What actually happens. Include screenshot, console error message, or curl response if relevant.

### Environment context
- Logged in as: anonymous / customer / biz-owner / partner / service-role
- Time of test: 2026-05-XX HH:MM PT
- Network conditions: normal wifi / slow 3G simulated / etc.

### Suggested fix (optional)
If obvious, a one-liner. If not, leave blank.

### Attachments
Screenshots, har files, console logs.
```

---

## Findings document template

Save your output as `LYMX Backend/TEST-FINDINGS-FROM-DAVE.md` (or `.docx`, your call).

```markdown
# LYMX Power — Test Findings (Dave)

**Tester:** Dave Spencer Bacay
**Test period:** 2026-05-XX through 2026-05-XX
**Total time spent:** XX hours
**Test plan version:** 1.0 (LYMX Backend/TEST-PLAN-FOR-DAVE.md)

---

## Summary

- **Pages tested:** XX of 221
- **Endpoints tested:** XX of XX
- **Total findings:** XX (P0: XX, P1: XX, P2: XX, P3: XX)
- **Showstoppers for launch:** [bulleted list of P0 IDs]
- **Recommended pre-launch fixes:** [bulleted list of P1 IDs]
- **Overall assessment:** [your honest take in 2-3 sentences. Is this launch-ready? What worries you most?]

---

## Section A — Public website

| Test ID | Page | Status | Severity | Issue # | Notes |
|---|---|---|---|---|---|
| A.1.1 | index.html | ✅ Pass | — | — | Loads cleanly across all browsers |
| A.1.2 | about.html | ❌ Fail | P1 | #42 | Mobile layout has horizontal scroll at 375px |
| ... | ... | ... | ... | ... | ... |

(Add a row per page tested. Be exhaustive.)

---

## Section B — Form A signup

| Test ID | Test | Status | Severity | Issue # | Notes |
|---|---|---|---|---|---|
| B.1 | Mode 1 happy path | ✅ Pass | — | — | |
| ... | ... | ... | ... | ... | ... |

---

## Section C — Backend Edge Functions

| Test ID | Endpoint | Status | Severity | Issue # | Notes |
|---|---|---|---|---|---|
| C.6 | customer-wallet-create | ✅ Pass | — | — | Idempotency confirmed |
| ... | ... | ... | ... | ... | ... |

---

## Section D — Square POS

| Test ID | Test | Status | Severity | Issue # | Notes |
|---|---|---|---|---|---|
| D.1 | square-oauth-init | DEFERRED | — | — | Endpoints not deployed yet |

---

## Section E — Cross-cutting

| Test ID | Test | Status | Severity | Issue # | Notes |
|---|---|---|---|---|---|
| E.2 | Performance — homepage | ✅ Pass | — | — | Lighthouse mobile 87, desktop 95 |
| ... | ... | ... | ... | ... | ... |

---

## Detailed findings

For each finding, paste the full GitHub issue body here so the doc is self-contained even if issues get closed/merged later.

### Finding 1 — [Title]
[Full issue body]

### Finding 2 — [Title]
[Full issue body]

...

---

## Things outside the test plan that I noticed

(Free-form. If you spotted anything weird that didn't fit a test ID — outdated copy, suspicious code patterns, missing logs, anything — note it here. Often the most valuable section.)

---

## Open questions for Kenny

(Anything you couldn't determine on your own — missing docs, ambiguous expected behavior, unclear product decisions. List them here so the next session can resolve them.)
```

---

## Working agreement & escalation

- **Daily check-in:** at the end of each test day, push the WIP findings doc to the `dave-workspace` branch on GitHub. That way Kenny can spot-check progress.
- **Blocking issue?** If you hit something that blocks further testing (e.g., a critical endpoint is 500ing, a credential doesn't work), STOP — message Kenny immediately. Don't burn hours fighting a setup issue.
- **Found a P0?** File the issue, mention it in #lymx-power Slack (or wherever we coordinate), and keep going on other tests in parallel.
- **Done?** When all sections are complete to the level you can take them, push the final `TEST-FINDINGS-FROM-DAVE.md` to a new branch (e.g., `dave/test-findings-2026-05`) and open a PR for Kenny to review.

---

## Appendix — Test data quick reference

### Sample Mode 1 storefront payload
```json
{
  "kind": "storefront",
  "owner_email": "dave-test-1234@smoketest.dev",
  "owner_password": "testpass1234!",
  "legal_name": "[TEST] Smoke Cafe LLC",
  "display_name": "[TEST] Smoke Cafe",
  "category": "Cafe / coffee",
  "contact_email": "hello@smoketest.dev",
  "contact_phone": "+17025550101",
  "issuance_rate": 5,
  "location": {
    "name": "Main",
    "street": "123 Smoke Ln",
    "city": "Las Vegas",
    "state": "NV",
    "zip": "89101"
  }
}
```

### Sample Mode 3 self-employed payload
```json
{
  "kind": "self_employed",
  "owner_email": "dave-test-5678@smoketest.dev",
  "owner_password": "testpass1234!",
  "legal_name": "[TEST] Jane Smoke Consulting LLC",
  "display_name": "[TEST] Jane Smoke",
  "category": "Consulting",
  "contact_email": "jane@smoketest.dev",
  "contact_phone": "+17025550202",
  "service_area": "Clark County, NV",
  "services": [
    { "service_name": "60-min consult", "price_usd": 150, "lymx_per_booking": 1500 },
    { "service_name": "Project audit",  "price_usd": 500, "lymx_per_booking": 5000 }
  ]
}
```

### Cleanup query (run after testing)
```sql
-- Preview
select id, email, created_at from auth.users
where email like '%@smoketest.dev'
   or email like 'dave-test-%';

-- Delete (have Kenny confirm before running)
-- delete from auth.users
-- where email like '%@smoketest.dev'
--    or email like 'dave-test-%';
```

---

## Sign-off

When you're done, fill in this section in your findings doc:

> **Test plan v1.0 completed by Dave on 2026-05-XX. Total findings: XX. Recommend [LAUNCH / DELAY-FOR-FIXES / MAJOR-RETHINK] based on overall site readiness.**

That's it. Have at it. Reach out if anything in this doc is unclear — better to ask now than waste time testing the wrong thing.

— Kenny
