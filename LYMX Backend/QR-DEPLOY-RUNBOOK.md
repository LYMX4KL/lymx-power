# QR Scan-to-Issue/Redeem — Deploy Runbook (2026-05-25)

## What this feature ships

Two-direction QR-based LYMX issuance between customers and businesses:

1. **Biz scans customer QR** → biz-dashboard scanner reads the customer's
   personal `qr_token`, biz types $ amount, LYMX issued immediately via the
   existing `/functions/v1/issuance` pipeline (no auth change — biz owner
   was already authorized to issue against any customer_id).

2. **Customer scans biz QR** → customer wallet scanner reads the biz's
   `qr_token`, customer types $ amount, a row lands in `lymx_qr_claims`
   in `pending` state. Biz sees it on biz-dashboard "Pending claims" panel
   and Approves or Rejects. Approve calls `/issuance` via service role.

QR codes encode rotatable UUID tokens (not raw IDs), so any leaked QR can be
invalidated per-row via `rotate_qr_token(kind, target_id)`.

## Deploy order

Apply in this order. Each step is idempotent (safe to re-run).

### 1. Database — migration 088

Paste the contents of `migrations/088_qr_scan_issue_redeem.sql` into the
Supabase SQL editor (project `apffootxzfwmtyjlnteo`) and run.

After the migration runs, every existing business and customer row will
have a populated `qr_token` from the column default. No backfill needed.

**Sanity checks** in SQL editor:
```sql
-- Both columns + indexes exist
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name IN ('businesses','customers')
  AND column_name='qr_token';

-- Claim table + RLS
SELECT relname, relrowsecurity FROM pg_class WHERE relname='lymx_qr_claims';

-- RPCs callable
SELECT public.resolve_qr_token(
  (SELECT qr_token FROM public.businesses LIMIT 1),
  'business'
);
-- Expect: { "ok": true, "kind": "business", "id": "...", "name": "..." }
```

### 2. Edge Functions — 3 to deploy

Each function lives in its own folder under `LYMX Backend/functions/`:

- `qr-resolve/index.ts`     — anon-callable, looks up display info for a scanned token
- `qr-claim/index.ts`       — customer JWT, creates a pending claim
- `qr-claim-approve/index.ts` — biz owner JWT, approves/rejects + calls /issuance

Deploy each via the Supabase dashboard `Edge Functions → New function`,
paste the index.ts content, deploy.

**Important:** `qr-resolve` calls a SECURITY DEFINER RPC GRANTed to anon —
**disable JWT verification** for that function so anon clients can call it
directly. The other two require JWT.

After deploying, verify each is callable:
```bash
# qr-resolve (anon key OK)
curl -X POST https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/qr-resolve \
  -H 'Authorization: Bearer <ANON_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{"token":"<some-real-business-qr-token>","kind":"business"}'

# qr-claim (customer JWT)
curl -X POST .../functions/v1/qr-claim \
  -H 'Authorization: Bearer <CUSTOMER_JWT>' \
  -H 'Content-Type: application/json' \
  -d '{"biz_qr_token":"...","usd_amount":12.50}'

# qr-claim-approve (biz owner JWT)
curl -X POST .../functions/v1/qr-claim-approve \
  -H 'Authorization: Bearer <BIZ_OWNER_JWT>' \
  -H 'Content-Type: application/json' \
  -d '{"claim_id":"...","action":"approve"}'
```

### 3. Frontend

After DB + EFs are live, push the frontend changes (biz-dashboard.html and
customer-dashboard.html / wallet.html). Those UIs assume the backend is
already in place; deploying frontend first would surface "RPC not found"
errors during user testing.

## QR payload format

QR codes encode a stable URL so existing camera apps (iOS/Android default
camera) work without needing the LYMX app:

```
https://getlymx.com/scan?k=b&t=<biz_qr_token>
https://getlymx.com/scan?k=c&t=<customer_qr_token>
```

`/scan.html` (frontend) reads the `k` + `t` params, calls `qr-resolve`, and
routes to the appropriate next-step UI (customer scanner → claim flow; biz
scanner → issuance amount prompt).

## Rotation

If a QR is leaked (sticker photographed and shared online):
```sql
SELECT public.rotate_qr_token('business', '<business_id>');  -- caller must own the biz
```
The function returns the new token. Reprint the QR sticker with the new
encoded URL; old QRs immediately return `token_not_found`.

## Future v2 work (NOT in this deploy)

- Print-ready PDF generator for biz QR stickers (8.5×11, foldable counter
  card, brand colors).
- Wallet pass / Apple Wallet / Google Wallet integration for customer QR
  so customers don't have to open the LYMX app.
- WebAuthn confirmation step for biz approvals over a $ threshold.
- Geo-fencing: refuse claims where the customer's IP is >50 mi from the biz
  location.
