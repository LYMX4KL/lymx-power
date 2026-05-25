// =============================================================================
// LYMX Power — QR Claim Approve/Reject (biz-side)
// =============================================================================
// POST /functions/v1/qr-claim-approve
//
// Biz owner approves or rejects a pending customer-initiated claim. On
// approve, we call the existing /functions/v1/issuance pipeline via service
// role so the same audit + balance update + LYMX issuance happens as if
// the biz had typed the amount in directly.
//
// AUTH: biz owner JWT (must own the business the claim is against), or
// service role.
//
// REQUEST BODY:
//   { "claim_id": "uuid", "action": "approve" | "reject", "reason": "optional" }
//
// RESPONSE (200):
//   { ok: true, status: "approved", transaction_id, lymx_issued }
//   { ok: true, status: "rejected" }
//   { ok: false, error: "..." }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

function getJwtRole(jwt: string): string | null {
    try {
        const parts = jwt.split(".");
        if (parts.length !== 3) return null;
        const payload = JSON.parse(
            atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
        );
        return payload.role ?? null;
    } catch {
        return null;
    }
}

interface ApproveBody {
    claim_id?: string;
    action?: "approve" | "reject";
    reason?: string;
}

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
        return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
        return jsonResponse({ ok: false, error: "missing_auth" }, 401);
    }
    const token = authHeader.replace("Bearer ", "");

    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } }
    );

    // Identify caller
    const isServiceRole = getJwtRole(token) === "service_role";
    let callerUserId: string | null = null;
    if (!isServiceRole) {
        const { data: { user }, error: uErr } = await supabase.auth.getUser(token);
        if (uErr || !user) {
            return jsonResponse({ ok: false, error: "invalid_auth" }, 401);
        }
        callerUserId = user.id;
    }

    let body: ApproveBody;
    try {
        body = await req.json();
    } catch {
        return jsonResponse({ ok: false, error: "invalid_json" }, 400);
    }
    if (!body.claim_id) {
        return jsonResponse({ ok: false, error: "claim_id_required" }, 400);
    }
    if (body.action !== "approve" && body.action !== "reject") {
        return jsonResponse({ ok: false, error: "action_must_be_approve_or_reject" }, 400);
    }

    // 1) Load the claim + verify biz ownership
    const { data: claim, error: claimErr } = await supabase
        .from("lymx_qr_claims")
        .select("id, customer_id, business_id, usd_amount, status, pending_until, businesses!inner(owner_user_id)")
        .eq("id", body.claim_id)
        .maybeSingle();
    if (claimErr) {
        console.error("[qr-claim-approve] load error", claimErr);
        return jsonResponse({ ok: false, error: "claim_lookup_failed" }, 500);
    }
    if (!claim) {
        return jsonResponse({ ok: false, error: "claim_not_found" }, 404);
    }
    if (claim.status !== "pending") {
        return jsonResponse({ ok: false, error: "claim_already_" + claim.status }, 400);
    }
    if (new Date(claim.pending_until) < new Date()) {
        // Auto-expire and refuse
        await supabase.from("lymx_qr_claims").update({ status: "expired" }).eq("id", claim.id);
        return jsonResponse({ ok: false, error: "claim_expired" }, 400);
    }

    // deno-lint-ignore no-explicit-any
    const ownerUid = (claim as any).businesses?.owner_user_id;
    if (!isServiceRole) {
        if (!ownerUid || ownerUid !== callerUserId) {
            return jsonResponse({ ok: false, error: "not_business_owner" }, 403);
        }
    }

    // ---- REJECT path -------------------------------------------------------
    if (body.action === "reject") {
        const { error: rejErr } = await supabase
            .from("lymx_qr_claims")
            .update({
                status: "rejected",
                rejected_at: new Date().toISOString(),
                rejected_by: callerUserId || null,
                rejected_reason: body.reason || null,
            })
            .eq("id", claim.id);
        if (rejErr) {
            console.error("[qr-claim-approve] reject update", rejErr);
            return jsonResponse({ ok: false, error: "reject_failed" }, 500);
        }
        return jsonResponse({ ok: true, status: "rejected" }, 200);
    }

    // ---- APPROVE path: call the existing /issuance EF via service role ----
    const issuanceUrl = Deno.env.get("SUPABASE_URL")! + "/functions/v1/issuance";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const issuanceResp = await fetch(issuanceUrl, {
        method: "POST",
        headers: {
            "Authorization": "Bearer " + serviceKey,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            business_id: claim.business_id,
            customer_id: claim.customer_id,
            usd_amount: Number(claim.usd_amount),
            note: "QR claim " + claim.id.slice(0, 8),
            pos_external_id: "qr_claim_" + claim.id,  // idempotency key
        }),
    });
    const issuanceJson = await issuanceResp.json().catch(() => null);

    if (!issuanceResp.ok || !issuanceJson?.transaction_id) {
        console.error("[qr-claim-approve] /issuance failed", issuanceResp.status, issuanceJson);
        return jsonResponse({
            ok: false,
            error: "issuance_failed",
            status: issuanceResp.status,
            detail: issuanceJson,
        }, 500);
    }

    // Mark the claim approved + link the transaction
    const { error: apErr } = await supabase
        .from("lymx_qr_claims")
        .update({
            status: "approved",
            approved_at: new Date().toISOString(),
            approved_by: callerUserId || null,
            transaction_id: issuanceJson.transaction_id,
        })
        .eq("id", claim.id);
    if (apErr) {
        // The LYMX has already been issued — log loudly but don't fail the
        // response. Worst case the claim row stays 'pending' but the txn is
        // real; biz can confirm by checking transactions or the customer
        // receiving the issuance email.
        console.error("[qr-claim-approve] claim status update failed AFTER successful issuance", apErr);
    }

    return jsonResponse({
        ok: true,
        status: "approved",
        transaction_id: issuanceJson.transaction_id,
        lymx_issued: issuanceJson.lymx_issued,
        new_balance: issuanceJson.new_balance,
    }, 200);
});
