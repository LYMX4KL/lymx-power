# 2 Edge Functions need redeploy — biz-onboarding audit fixes

Source files on disk are updated, but the live deployed versions are still the old code. Both EFs need to be pasted into the Supabase Edge Functions code editor and deployed.

## What changed

### 1. `business-signup` — added admin notification fan-out

When a new biz signs up, the EF now ALSO emails every member of `staff_roles` (plus `hello@getlymx.com` as a belt-and-suspenders catch). Without this you don't know a new application exists until you remember to open `admin-business-applications.html`.

Diff: a new `try { ... } catch { }` block inserted between the existing "Business welcome email" block and the final `return jsonResponse(...)`. Look for the comment marker `// ─── Admin notification (audit fix 2026-05-24) ───`.

Source: `LYMX Backend/functions/business-signup/index.ts` (also copied to `PENDING-EF-DEPLOY-business-signup.ts` for easier paste-into-Monaco).

### 2. `issuance` — gate on `approval_status='approved'`

Two changes:

- Wallet join now also pulls `approval_status` from the joined businesses row.
- Right after the existing `archived_at` check, a new check rejects the call with a friendly message if the business is still pending / rejected. Service-role callers bypass (so the platform welcome bonus still issues correctly).

Diff:

```diff
-            "businesses!inner(owner_user_id, issuance_rate, archived_at)"
+            "businesses!inner(owner_user_id, issuance_rate, archived_at, approval_status)"
```

```diff
     if (biz.archived_at) {
         return errorResponse("Business is archived", 400);
     }
+    // 2026-05-24 audit fix: refuse issuance until the business has been
+    // approved by admin. Without this gate, a fresh signup whose
+    // approval_status is still "pending" / "rejected" / null could call
+    // /functions/v1/issuance from biz-dashboard the moment the auth user
+    // is created — that bypasses Kenny's Founding-25 / quality-control
+    // workflow. Service-role callers (internal backfills, the platform
+    // bonus issuance) bypass this gate by design.
+    if (!isServiceRole && biz.approval_status !== "approved") {
+        return errorResponse(
+            "Business is not approved yet. Your application is " + (biz.approval_status || "pending") + " — you can start issuing LYMX once the LYMX team approves your account (usually within 24 hours).",
+            403
+        );
+    }

     // Authorization: business owner OR service role
```

Source: `LYMX Backend/functions/issuance/index.ts` (also copied to `PENDING-EF-DEPLOY-issuance.ts`).

## Deploy steps

For each EF:

1. Open https://supabase.com/dashboard/project/apffootxzfwmtyjlnteo/functions/<NAME>/code (replace `<NAME>` with `business-signup` or `issuance`).
2. Open the local file (`PENDING-EF-DEPLOY-business-signup.ts` or `PENDING-EF-DEPLOY-issuance.ts`).
3. Select-all in the local file, copy.
4. In the Monaco editor on the Supabase page, Ctrl+A to select all, then Ctrl+V to paste.
5. Click **Deploy**.

The migration that adds `address_line1` / `tagline` / `description` / `emoji` to `businesses` already ran successfully (migration 077).

After both EFs are deployed, the biz-onboarding flow is complete for Susan's launch batch.


## Update (post-audit) — business-signup gained an "intake" persister

After Kenny redeployed the first version this morning, the audit added a third change to `business-signup`: it now reads the new `body.intake` object from biz-signup.html (entity_type, ein, business_license_number, incorporation_state, year_founded, employee_count_range, website, operating_hours) and writes those fields onto the businesses row. Migration 078 added the columns; the EF still needs the updated source.

The latest `PENDING-EF-DEPLOY-business-signup.ts` is 601 lines — paste it back into Monaco and click Deploy again.

No change required for `issuance` since the deploy this morning already had the `approval_status='approved'` gate.
