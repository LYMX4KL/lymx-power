# RUNBOOK — 2026-05-23 — Open the gate (pw-reset + partner welcome + Helen onboarding)

This is Kenny's one-pass runbook. Steps must be done in order. Do not skip.

## What we're fixing

1. **Password-reset emails not arriving.** Root cause: your auth account uses
   `kenny.lin@getlymx.com`, which forces emails through Cloudflare Email
   Routing → silently drops them. Same hit Helen and likely 4-5 other partners.
2. **Helen never got her partner welcome.** Root cause: `partner-provision-email`
   stopped at the Cloudflare verification step (returned 202) and never sent
   the welcome.
3. **Helen has no admin access yet.** Need to grant her owner/CFO scope.
4. **Dave + Rachel can't use remote clock-in.** Root cause: `staff_roles.remote_allowed`
   defaults to FALSE; nobody flipped it.

The fix:
- Migration 073 lets anyone sign in with phone / personal email / company email
  and swaps auth.users.email off `@getlymx.com` to the user's real personal
  inbox. After this, pw-reset emails go DIRECTLY via Resend → real inbox.
- New EF `resolve-login-identifier` translates any identifier on the way in.
- Login + forgot-password pages now use the resolver.
- Migration 074 flips `remote_allowed` default to TRUE + opens the geofence.
- New admin page `admin-staff-locations.html` lets Helen enter staff addresses.
- `partner-provision-email` patched so Cloudflare verification is best-effort,
  not a hard gate — welcome always sends.

---

## Step 1 — Push everything to GitHub

```powershell
cd C:\Users\Kenny\Desktop\Gemini
.\push.ps1 -Message "2026-05-23 gate unblock: multi-identifier login + Helen access + remote clock-in"
```

That should pick up the recently-changed files. If `-MaxAgeHours 12` misses
anything, force it:

```powershell
.\push.ps1 -Message "..." -Files @(
  "LYMX Power\login.html",
  "LYMX Power\admin-staff-locations.html",
  "LYMX Power\admin-reserved-codes.html",
  "LYMX Backend\migrations\073_alt_login_identifiers.sql",
  "LYMX Backend\migrations\074_staff_home_address_and_remote_default.sql",
  "LYMX Backend\migrations\075_reserved_partner_codes.sql",
  "LYMX Backend\functions\resolve-login-identifier\index.ts",
  "LYMX Backend\functions\partner-provision-email\index.ts",
  "LYMX Backend\ADMIN-FIXES-2026-05-23.sql",
  "LYMX Backend\HELEN-WELCOME-EMAIL.html",
  "LYMX Backend\RUNBOOK-2026-05-23-GATE-UNBLOCK.md"
)
```

Wait ~60 seconds for Netlify to deploy.

## Step 2 — Apply migrations in Supabase SQL Editor

Project: **apffootxzfwmtyjlnteo** (LYMX — verify the project ref in the URL
before pasting; we have BOTH LYMX and InvestPro projects in your Supabase
account, and InvestPro is a different ref).

Run in this order (each in its own SQL editor tab):

1. Paste **`LYMX Backend\migrations\073_alt_login_identifiers.sql`** → Run.
   - Look for `NOTICE: migration 073 applied | alt_identifiers total=...` at
     the bottom. If you see an error about `partner_emails.full_email` not
     existing, partner_emails table is older than expected — ping me and we'll
     adjust.
2. Paste **`LYMX Backend\migrations\074_staff_home_address_and_remote_default.sql`** → Run.
   - Look for `NOTICE: migration 074 applied | staff_total=... with_anchor=... with_addr=... remote_on=...`.
   - This adds the home_office_address column and the display_name / work_email
     backfill. **Geofence stays strict** (200m default, remote_allowed default
     stays FALSE) — Helen will turn remote_allowed on only for staff who need it.
3. Paste **`LYMX Backend\migrations\075_reserved_partner_codes.sql`** → Run.
   - Look for `NOTICE: migration 075 applied | reserved=54 (assigned=N unassigned=...)`.
   - Pre-reserves all repeat-digit partner codes (P-000011 / P-000022 / …
     P-000999 / P-111111 / …) as rewards for high-producing partners.
   - Modifies the partner-code trigger so new signups SKIP these codes
     automatically. Existing partners keep their codes.

## Step 3 — Deploy the two Edge Functions

In Supabase Dashboard → Edge Functions:

1. **resolve-login-identifier** (NEW) — click "Deploy a new function" if it
   doesn't exist, name it `resolve-login-identifier`, paste the contents of
   `LYMX Backend\functions\resolve-login-identifier\index.ts`. **IMPORTANT:**
   disable the "Verify JWT" toggle (this is a public endpoint).
2. **partner-provision-email** (PATCHED) — click the existing function,
   paste the new contents of
   `LYMX Backend\functions\partner-provision-email\index.ts`, Deploy.

## Step 4 — Run the admin SQL one-shot

Paste **`LYMX Backend\ADMIN-FIXES-2026-05-23.sql`** in SQL editor → Run.

It will:
- Find your user_id + Helen's user_id, print them as NOTICEs.
- Grant Helen `admin` + `is_cfo` + `is_hr` + remote clock-in.
- Backfill alt_login_identifiers for both of you.
- Force-swap any leftover `@getlymx.com` auth emails to personal gmails.
- Print a final report row for you and Helen showing the end state.

If the final report shows your auth.users.email is still `kenny.lin@getlymx.com`,
something blocked the swap (probably a uniqueness collision because another
user already has `zhongkennylin@gmail.com` registered). Tell me what the
report shows and I'll write the resolution.

## Step 5 — Send Helen's welcome email

Open the partner-provision-email function with Helen's partner_id and
`force_welcome:true`. Easiest way is from your admin-partners page:

1. Go to https://getlymx.com/admin-partners.html
2. Find Helen's row → click **Resend welcome**.
3. Watch Resend logs (https://resend.com/emails?query=helen0510c) — within
   30 seconds you should see a "welcome" subject delivered to her gmail.

If she still doesn't see it: the email is at
`C:\Users\Kenny\Desktop\Gemini\LYMX Backend\HELEN-WELCOME-EMAIL.html` —
you can paste that into a normal email-to-Helen as a fallback.

## Step 6 — Verify the gate is open

In an INCOGNITO Chrome window (so cookies don't leak):

1. Go to `https://getlymx.com/login.html`.
2. Click "Forgot password?".
3. Enter `zhongkennylin@gmail.com` → submit.
4. Within 30 seconds the reset email should arrive in your gmail inbox.
5. Click the link, set a new password, sign in.
6. Repeat for Helen using `helen0510c@gmail.com` (have her do it on her end).

## Step 7 — Done. Helen takes over for Dave + Rachel

Helen signs in → goes to https://getlymx.com/admin-staff-locations.html →
enters Dave + Rachel's home addresses → leaves the geofence radius at
**200 metres** and "Remote allowed" **off** (strict, per Kenny's directive
— they punch in only from home) → tells them to clock in at
https://getlymx.com/staff-clock-in.html on their phones.

## Bonus — Reserved partner codes for rewards

Open https://getlymx.com/admin-reserved-codes.html to see the 54 pre-reserved
repeat-digit codes (P-000011 through P-999999 in their tiers — Platinum,
Gold, Silver, Standard). Click any green pill, paste a partner's UUID or
current code, hit Assign — their existing code swaps to the reserved one.
New signups skip these codes automatically so they stay safe until you give
them away.

---

## If something breaks

- **Migration 073 errors on auth.users update**: it requires running as
  postgres role; the SQL editor does that by default. If you see a
  permission error, run `SET ROLE postgres;` at the top.
- **resolve-login-identifier returns 401**: Verify JWT toggle is still ON.
  Turn it OFF in the function's Settings.
- **partner-provision-email still 202s**: you may have deployed the OLD
  index.ts. Re-paste from disk, Deploy.
- **Helen's grant SQL says "Helen not found"**: she doesn't have an auth.users
  row yet. Have her sign up at getlymx.com first, then re-run the script.

---

## What this DOES NOT do (deferred to next session)

- Phone-based signup with SMS OTP (the `alt_login_identifiers` table is
  ready for it; we'd just need Twilio wired into a phone-verify EF).
- Reconciliation job to retry Cloudflare destination verification for
  partner_emails rows where `cloudflare_route_id IS NULL`.
- The partner_provisioning_failures audit page (migration 072 ships the
  table; admin-partner-failures.html UI is still to-build).

These can wait. The gate is open.
