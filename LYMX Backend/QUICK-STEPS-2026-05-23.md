# QUICK STEPS — 2026-05-23 gate-unblock

## 1. PUSH ONE-LINER (paste in PowerShell)

```powershell
cd C:\Users\Kenny\Desktop\Gemini ; .\push.ps1 -Message "2026-05-23 gate unblock: multi-id login + Helen access + remote clock-in + reserved codes" -Files @("LYMX Power\login.html","LYMX Power\admin-staff-locations.html","LYMX Power\admin-reserved-codes.html","LYMX Backend\migrations\073_alt_login_identifiers.sql","LYMX Backend\migrations\074_staff_home_address_and_remote_default.sql","LYMX Backend\migrations\075_reserved_partner_codes.sql","LYMX Backend\functions\resolve-login-identifier\index.ts","LYMX Backend\functions\partner-provision-email\index.ts","LYMX Backend\ADMIN-FIXES-2026-05-23.sql","LYMX Backend\SET-FOUNDING-CODES-2026-05-23.sql","LYMX Backend\HELEN-WELCOME-EMAIL.html","LYMX Backend\RUNBOOK-2026-05-23-GATE-UNBLOCK.md")
```

Wait ~60s for Netlify deploy.

---

## 2. SQL — paste each block in Supabase SQL Editor, IN ORDER

Project: **apffootxzfwmtyjlnteo** (LYMX) — verify the URL before pasting.

| # | File | Look for in output |
|---|------|--------------------|
| 1 | `LYMX Backend\migrations\073_alt_login_identifiers.sql` | `NOTICE: migration 073 applied | alt_identifiers total=...` |
| 2 | `LYMX Backend\migrations\074_staff_home_address_and_remote_default.sql` | `NOTICE: migration 074 applied | staff_total=...` |
| 3 | `LYMX Backend\migrations\075_reserved_partner_codes.sql` | `NOTICE: migration 075 applied | reserved=54 ...` |
| 4 | `LYMX Backend\ADMIN-FIXES-2026-05-23.sql` | Final SELECT shows Kenny+Helen with personal-gmail emails + admin role |
| 5 | ~~SET-FOUNDING-CODES-2026-05-23.sql~~ | **SKIP** — Kenny will use the new admin-reserved-codes.html UI to assign IDs as a real-world test of the feature |

After SQL #4, open `https://getlymx.com/admin-reserved-codes.html` → assign Helen / Susan / Mandy each one of the green-pill reserved codes (P-000011, P-000022, P-000033, P-000088 — any tier you want). The UI calls the new `claim_reserved_partner_code()` RPC which audits the swap and frees the old code.

---

## 3. EDGE FUNCTIONS — Supabase Dashboard → Edge Functions

**A. resolve-login-identifier  (NEW — create + deploy)**
- Click "Deploy a new function"
- Name: `resolve-login-identifier`
- Paste contents of `LYMX Backend\functions\resolve-login-identifier\index.ts`
- **CRITICAL: turn OFF "Verify JWT"** (it's a public endpoint — login uses it before sign-in)
- Click Deploy

**B. partner-provision-email  (EXISTING — redeploy patched version)**
- Click the existing `partner-provision-email` function
- Click "Edit code" (or the code/index.ts tab)
- Select all → paste contents of `LYMX Backend\functions\partner-provision-email\index.ts`
- Click Deploy

---

## 4. VERIFY (incognito Chrome)

1. `https://getlymx.com/login.html` → Forgot password? → enter `zhongkennylin@gmail.com` → check gmail for reset link
2. Go to `https://getlymx.com/admin-partners.html` → find Helen → click "Resend welcome" → check Resend logs at https://resend.com/emails?query=helen0510c for the welcome email
3. Helen signs in with her gmail → tests the same forgot-password flow on her end

---

## Files I'm presenting next:

- `SET-FOUNDING-CODES-2026-05-23.sql` (new — partner code overrides)
- `QUICK-STEPS-2026-05-23.md` (this file)

Ping me when push.ps1 finishes and I'll be ready with bug-triage results.
