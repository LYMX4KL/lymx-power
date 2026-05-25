// =============================================================================
// LYMX Power — QR Claim (customer-initiated)
// =============================================================================
// POST /functions/v1/qr-claim
//
// When a customer scans a business's QR code, they call this EF with the
// biz_qr_token + the dollar amount they want to claim for their purchase.
// We create a row in lymx_qr_claims in 'pending' state. The biz then sees
// the claim on biz-dashboard and either approves (via qr-claim-approve) or
// rejects it.
//
// AUTH: customer JWT (authenticated). The EF resolves the customer row from
// the JWT's user_id — we never trust a customer_id passed in the body.
//
// REQUEST BODY:
//   { "biz_qr_token": "uuid", "usd_amount": 12.50, "note": "optional" }
//
// RESPONSE (200):
//   { ok: true, claim_id, business: { id, name }, pending_until }
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

interface ClaimBody {
    biz_qr_token?: string;
    usd_amount?: number;
    note?: string;
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

    // Service-role for the write; user-context for auth resolution.
    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } }
    );

    const { data: { user }, error: uErr } = await supabase.auth.getUser(token);
    if (uErr || !user) {
        return jsonResponse({ ok: false, error: "invalid_auth" }, 401);
    }

    let body: ClaimBody;
    try {
        body = await req.json();
    } catch {
        return jsonResponse({ ok: false, error: "invalid_json" }, 400);
    }

    if (!body.biz_qr_token) {
        return jsonResponse({ ok: false, error: "biz_qr_token_required" }, 400);
    }
    if (typeof body.usd_amount !== "number" || body.usd_amount <= 0) {
        return jsonResponse({ ok: false, error: "usd_amount_positive_required" }, 400);
    }
    if (body.usd_amount >= 100000) {
        return jsonResponse({ ok: false, error: "usd_amount_too_large" }, 400);
    }
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.biz_qr_token)) {
        return jsonResponse({ ok: false, error: "invalid_token_format" }, 400);
    }

    // 1) Resolve the biz from the token
    const { data: bizRows, error: bizErr } = await supabase
        .from("businesses")
        .select("id, display_name, archived_at, approval_status")
        .eq("qr_token", body.biz_qr_token)
        .limit(1);
    if (bizErr) {
        console.error("[qr-claim] biz lookup error", bizErr);
        return jsonResponse({ ok: false, error: "biz_lookup_failed" }, 500);
    }
    const biz = bizRows && bizRows[0];
    if (!biz) {
        return jsonResponse({ ok: false, error: "biz_not_found" }, 404);
    }
    if (biz.archived_at) {
        return jsonResponse({ ok: false, error: "biz_archived" }, 400);
    }
    if (biz.approval_status && biz.approval_status !== "approved") {
        return jsonResponse({ ok: false, error: "biz_not_approved" }, 400);
    }

    // 2) Resolve the customer from the auth user
    const { data: custRows, error: custErr } = await supabase
        .from("customers")
        .select("id")
        .eq("user_id", user.id)
        .limit(1);
    if (custErr) {
        console.error("[qr-claim] customer lookup error", custErr);
        return jsonResponse({ ok: false, error: "customer_lookup_failed" }, 500);
    }
    const customerId = custRows && custRows[0] && custRows[0].id;
    if (!customerId) {
        return jsonResponse({ ok: false, error: "no_customer_row" }, 400);
    }

    // 3) Insert the pending claim
    const { data: claim, error: insErr } = await supabase
        .from("lymx_qr_claims")
        .insert({
            customer_id: customerId,
            business_id: biz.id,
            usd_amount: body.usd_amount,
            note: body.note || null,
        })
        .select("id, pending_until")
        .maybeSingle();
    if (insErr) {
        console.error("[qr-claim] insert error", insErr);
        return jsonResponse({ ok: false, error: "claim_insert_failed", detail: insErr.message }, 500);
    }

    return jsonResponse({
        ok: true,
        claim_id: claim!.id,
        pending_until: claim!.pending_until,
        business: { id: biz.id, name: biz.display_name },
    }, 200);
});
