# Deploy 3 partner-email Edge Functions + smoke test (2026-05-07)

> All prerequisites are done. This doc walks through the **final mile** — deploying 3 Edge Functions to Supabase and smoke-testing the partner email pipeline end-to-end.
>
> Estimated time: **45-60 min** total.

## Pre-flight check (verify before starting)

| Item | Where | Confirm |
|---|---|---|
| getlymx.com DNS on Cloudflare | https://dash.cloudflare.com → getlymx.com | Status: **Active** |
| getlymx.com SES identity verified | https://us-east-1.console.aws.amazon.com/ses → Identities → getlymx.com | DKIM: **Verified** (green) AND MAIL FROM: **Verified** |
| Resend getlymx.com verified | https://resend.com/domains | getlymx.com status: **Verified** |
| 9 Supabase secrets set | https://supabase.com/dashboard/project/apffootxzfwmtyjlnteo/functions/secrets | 9 entries with hashes |
| Migration 005 run | Supabase SQL editor: `\dt public.partner_emails` | Table exists, 18 cols |

If anything above isn't ✅, fix it first. The Edge Functions will return 500 if dependencies aren't ready.

---

## Step 1 — Deploy `partner-provision-email`

This is the largest of the three. Has a `_shared/email/templates/partner-welcome.ts` import and a `_shared/cors.ts` import.

1. Supabase dashboard → **Edge Functions** → **Deploy a new function** → **Via Editor**
2. **Function name:** `partner-provision-email`
3. The default `index.ts` opens. Click into the editor, **Cmd-A** to select all, then paste the contents of:
   ```
   C:\Users\Kenny\Desktop\Gemini\LYMX Backend\functions\partner-provision-email\index.ts
   ```
4. Now add the shared template file:
   - Click **+ Add File** in the file panel
   - Filename: `_shared/email/templates/partner-welcome.ts`
   - Paste contents of:
     ```
     C:\Users\Kenny\Desktop\Gemini\LYMX Backend\functions\_shared\email\templates\partner-welcome.ts
     ```
5. Add the cors helper:
   - Click **+ Add File** again
   - Filename: `_shared/cors.ts`
   - Paste contents of:
     ```
     C:\Users\Kenny\Desktop\Gemini\LYMX Backend\functions\_shared\cors.ts
     ```
6. Click **Deploy function** (bottom right, green button)
7. Wait for "Deployed successfully"

**If deploy fails** with import errors → likely the file path is wrong. The `_shared/` folder must be at the function's relative root. Folder structure in editor should look like:

```
index.ts
_shared/
  cors.ts
  email/
    templates/
      partner-welcome.ts
```

---

## Step 2 — Deploy `partner-acknowledge-email`

Smaller, only needs cors.ts.

1. Edge Functions → Deploy a new function → Via Editor
2. Function name: `partner-acknowledge-email`
3. Replace default `index.ts` with contents of:
   ```
   C:\Users\Kenny\Desktop\Gemini\LYMX Backend\functions\partner-acknowledge-email\index.ts
   ```
4. Add `_shared/cors.ts` (same contents as before)
5. Deploy

---

## Step 3 — Deploy `partner-revoke-email`

1. Edge Functions → Deploy a new function → Via Editor
2. Function name: `partner-revoke-email`
3. Replace default `index.ts` with contents of:
   ```
   C:\Users\Kenny\Desktop\Gemini\LYMX Backend\functions\partner-revoke-email\index.ts
   ```
4. Add `_shared/cors.ts`
5. Deploy

After all 3 deploy, the Edge Functions list should show **9 functions in total** (the 6 existing + the 3 new).

---

## Step 4 — Smoke test the pipeline end-to-end

Per `PARTNER-EMAIL-SETUP.md` §E, but with current values.

### 4.1 — Set bash env vars (in your terminal)

```bash
export SUPABASE_URL="https://apffootxzfwmtyjlnteo.supabase.co"
export SUPABASE_ANON_KEY="<from Supabase dashboard → Settings → API>"
export SUPABASE_SERVICE_ROLE_KEY="<from same page, mark secret>"
```

### 4.2 — Create a test partner via SQL editor

```sql
-- Create a test auth user first (or use one of the smoke-test users
-- left over from Phase 1/2). For a brand-new test:
-- (Run in Supabase SQL editor as service role)

-- Step A — create the auth.users row (you may need to use Supabase auth admin API
-- or create via a signup flow; direct insert into auth.users is restricted)
-- For smoke test, use the simplest path: sign up via business-signup endpoint with kind=storefront
-- using an email like dave-smoketest-1@smoketest.dev. That gives you an auth.users.id.

-- Step B — insert the partners row
insert into public.partners (
    user_id, legal_name, display_name, contact_email, is_founding_25
) values (
    '<the auth.users.id from step A>',
    'Smoke Test Partner',
    'Smoke Test Partner',
    'zhongkennylin+smoketest@gmail.com',  -- your real Gmail with + alias so you receive it
    true
)
returning id;
-- Save the returned id.
```

### 4.3 — Provision the email

```bash
PARTNER_ID="<the id from above>"

curl -sS -X POST "$SUPABASE_URL/functions/v1/partner-provision-email" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"partner_id\": \"$PARTNER_ID\"}" | jq .
```

**Expected:** `{"success": true, "full_email": "smoke.test.partner@getlymx.com", "status": "active"}`

### 4.4 — Verify in DB

```sql
select id, partner_id, local_part, full_email, forward_to, status,
       cloudflare_route_id, ses_identity_verified,
       provisioned_at, onboarding_email_sent_at
from public.partner_emails
where partner_id = '<the partner id>';
```

Expect: status='active', cloudflare_route_id populated, ses_identity_verified=true, both timestamps populated.

### 4.5 — Verify the welcome email arrived

Check `zhongkennylin+smoketest@gmail.com` → there should be an email from `LYMX <hello@getlymx.com>` with the welcome content + Gmail Send-mail-as setup instructions.

### 4.6 — Verify inbound forwarding

Send a test email from any other email account to `smoke.test.partner@getlymx.com`. Should arrive in your personal Gmail within ~30 seconds (via Cloudflare Email Routing).

### 4.7 — Verify outbound send-as (optional but valuable)

In Gmail → Settings → Accounts and Import → Send mail as → Add another email address. Use the SMTP creds from the welcome email. Once verified, send a test email FROM `smoke.test.partner@getlymx.com` to `zhongkennylin@gmail.com`. Should deliver successfully via SES.

### 4.8 — Test revoke

```bash
curl -sS -X POST "$SUPABASE_URL/functions/v1/partner-revoke-email" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"partner_id\": \"$PARTNER_ID\"}" | jq .
```

**Expected:** `{"success": true, "status": "suspended", "cloudflare_route_deleted": true}`

Then send another test to `smoke.test.partner@getlymx.com` → should bounce or not arrive.

---

## Troubleshooting

**Deploy fails with `Module not found '../_shared/email/templates/partner-welcome.ts'`** — The shared file isn't in the right place in the editor. Check the file tree: it must be `_shared/email/templates/partner-welcome.ts` (relative to the function root in the editor, NOT relative to the index.ts).

**Provision endpoint returns 500 with "CF_API_TOKEN_LYMX is undefined"** — Secrets not loaded. Either secret missing (re-check `Supabase → Edge Functions → Secrets`) or Edge Function wasn't redeployed after secrets added (Supabase doesn't hot-reload secrets — re-deploy the function).

**Provision returns "Cloudflare route create failed: 403"** — CF API token doesn't have the right perms or wrong zone. Re-check the token has `Email Routing Rules:Edit` AND `Zone DNS:Edit` scoped to `getlymx.com`.

**Welcome email lands in Gmail spam** — New SES identity. SES has a "warm-up" period. Send small volumes first, mark as "Not spam" if needed.

**SMTP relay rejects the partner's send-as** — SES sender identity not verified yet. Check SES → Verified identities. Identity verification can take up to 72 hours but usually completes in 5-15 min.

---

## When done

When all 4 smoke tests pass, the partner email feature is **LAUNCH READY**.

Next session priorities (in suggested order):
1. Process Dave's findings doc (`TEST-FINDINGS-FROM-DAVE.md`) — fix P0/P1 bugs from his website testing
2. Design the share-to-earn rewards feature (per `project_lymx_engagement_rewards.md` memory)
3. Wire the Square POS Phase 3 integration if not done
4. Plan the first marketing send via `@lymxpower.com` to drive Founding 25 partner signups
