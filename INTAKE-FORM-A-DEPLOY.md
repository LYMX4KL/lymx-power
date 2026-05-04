# Form A — Deploy checklist (2026-05-04)

Step-by-step for Kenny. Do these IN ORDER. Mark each ✅ as you go.

---

## What got built today

| File | Where it lives | Purpose |
|---|---|---|
| `migrations/006_intake_forms.sql` | `Gemini/LYMX Backend/migrations/` | Adds `business_kind` discriminator + `business_custom_services` table |
| `functions/business-signup/index.ts` | `Gemini/LYMX Backend/functions/business-signup/` | **REPLACED**. Now accepts `kind: storefront` or `kind: self_employed` payloads |
| `biz-signup.html` | `Gemini/LYMX Power/` | The actual sign-up page customers fill out |
| `smoke-tests/form-a-signup.sh` | `Gemini/LYMX Backend/smoke-tests/` | curl-based test of all 3 cases |
| `INTAKE-FORMS-WORKING-DOC.md` | `Gemini/LYMX Power/` | Sections 1-6 fully drafted |

What's NOT built yet (waiting on InvestPro feedback): Form B (firm intake), Mode 2 (agent at firm), the firm/agent SQL tables (migration 007).

---

## Deploy steps

### ✅ Step 1 — Apply migration 006 to Supabase

1. Open the Supabase SQL editor: https://supabase.com/dashboard/project/apffootxzfwmtyjlnteo/sql
2. Click **+ New query**.
3. Open `Gemini/LYMX Backend/migrations/006_intake_forms.sql` on your computer, copy the whole file.
4. Paste into the SQL editor and click **Run**.
5. Expect: "Success. No rows returned."
6. Verification — paste this into the same editor and run:
   ```sql
   select column_name, data_type, column_default
   from information_schema.columns
   where table_schema='public' and table_name='businesses' and column_name='business_kind';
   -- expect 1 row, default = 'storefront'

   select count(*) from public.business_custom_services;  -- expect 0
   ```

### ✅ Step 2 — Redeploy `business-signup` Edge Function

1. Open: https://supabase.com/dashboard/project/apffootxzfwmtyjlnteo/functions
2. Click on **business-signup**.
3. Click **Edit function** (top right).
4. Open `Gemini/LYMX Backend/functions/business-signup/index.ts` on your computer.
5. **Select all** in the web editor → delete → paste the new file contents.
6. Click **Deploy**.
7. Wait for the green "Deployed" toast.

### ✅ Step 3 — Smoke test from your terminal

```bash
cd "Gemini/LYMX Backend"

# Anon key from: dashboard → Project Settings → API → "anon public"
export SUPABASE_URL="https://apffootxzfwmtyjlnteo.supabase.co"
export SUPABASE_ANON_KEY="ey…paste it here…"

bash smoke-tests/form-a-signup.sh
```

Expect: "🎉 All 3 Form A smoke tests passed."

If anything fails, copy the output and paste it back here — we'll debug together.

### ✅ Step 4 — Wire up the live form (optional today)

`biz-signup.html` has a `LYMX_CONFIG` block near the bottom:
```js
const LYMX_CONFIG = {
  SUPABASE_URL: 'https://apffootxzfwmtyjlnteo.supabase.co',
  SUPABASE_ANON_KEY: 'REPLACE_WITH_ANON_KEY'
};
```
Replace `REPLACE_WITH_ANON_KEY` with the same anon key you used in Step 3.
Once that's done, the form will actually post to the live function.

You can also wait on this until you've got a `biz-signup` link in the main nav — your call.

### ✅ Step 5 — Push commits to GitHub

Two repos, two pushes:

**Backend (`lymx-power-backend` or wherever your backend repo lives):**
```
git add migrations/006_intake_forms.sql
git add functions/business-signup/index.ts
git add smoke-tests/form-a-signup.sh
git commit -m "Form A intake: migration 006 + signup endpoint accepts storefront + self_employed"
git push
```

**Site (`lymx-power`):**
```
git add biz-signup.html
git add "LYMX Power/INTAKE-FORMS-WORKING-DOC.md"   # full Section 1-6 spec
git add "LYMX Power/INTAKE-FORM-A-DEPLOY.md"
git commit -m "Form A: biz-signup.html + working doc sections 1-6 drafted"
git push
```

Netlify should auto-deploy the site within ~1 minute of the push.

---

## What's pending after today

- [ ] **Migration 004 + 005** still need to be applied — they were written earlier but never run on Supabase. Worth knocking out before 006 if you haven't already (006 doesn't depend on them, but it's tidier to apply in order).
- [ ] **Square webhook** code is local only — push to GitHub when you're back on a stable connection (still tracked).
- [ ] **InvestPro feedback on Form B** — once they sign off on the firm fields and the 20 fee scenarios, we'll write migration 007 (firm/agent tables) and Form B.
- [ ] **Anon-key rotation note** — once `biz-signup.html` ships with the live anon key in source, that key is public (it's designed to be). If you ever need to rotate it, it's just a Supabase dashboard click + a one-line change in this file.

---

*Drafted 2026-05-04. After deploying, drag-drop the updated `LYMX Power` and `LYMX Backend` folders back to your Drive so the laptop and desktop stay in sync.*
