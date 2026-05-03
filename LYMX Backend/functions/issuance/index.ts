// =============================================================================
// LYMX Power — Issuance Endpoint
// =============================================================================
// POST /functions/v1/issuance
//
// A business issues LYMX to a customer based on a $ purchase.
// LYMX_issued = round( usd_amount * issuance_rate )   (default 5/$1)
//
// AUTH: Caller must be the owner of the business (`owner_user_id` check),
// OR be using the service role key (for POS integrations / admin tools).
//
// REQUEST HEADERS:
//   Authorization: Bearer <user_jwt or service_role_key>
//
// REQUEST BODY (JSON):
// {
//   "business_id": "uuid",
//   "customer_id": "uuid",        // pre-resolved by phone lookup, or pass via wallet
//   "wallet_id": "uuid",          // alternative to customer_id+business_id
//   "location_id": "uuid",        // optional, defaults to primary
//   "usd_amount": 12.50,          // dollars spent on the underlying purchase
//   "pos_external_id": "sq_abc",  // optional, idempotency key
//   "note": "string"              // optional
// }
//
// RESPONSE (200):
// {
//   "transaction_id": "uuid",
//   "wallet_id": "uuid",
//   "lymx_issued": 63,
//   "new_balance": 1042.0,
//   "lifetime_earned": 4218.0
// }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// --- CORS + response helpers (inlined for web-editor deployment) -----------
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
const errorResponse = (message: string, status = 400) =>
    jsonResponse({ error: message }, status);

interface IssuanceBody {
    business_id?: string;
    customer_id?: string;
    wallet_id?: string;
    location_id?: string;
    usd_amount: number;
    pos_external_id?: string;
    note?: string;
}

/**
 * Decode the JWT and check the `role` claim.
 *
 * Why this and not `token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")`:
 * Supabase's Edge Function gateway can re-stamp the Authorization header,
 * so the literal token we see may differ from the env var. Comparing the
 * decoded `role` claim is reliable for both legacy service_role keys and
 * gateway-stamped service_role JWTs (both have payload.role === 'service_role').
 */
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

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
        return errorResponse("Method not allowed", 405);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
        return errorResponse("Missing Authorization header", 401);
    }
    const token = authHeader.replace("Bearer ", "");

    // Service-role client for the actual writes
    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } }
    );

    // Identify caller: either a user (must be biz owner) or service role.
    // Use JWT role-claim decode (not literal token compare) — the Supabase
    // Edge Function gateway can re-stamp the Authorization header.
    const isServiceRole = getJwtRole(token) === "service_role";
    let callerUserId: string | null = null;
    if (!isServiceRole) {
        const { data: { user }, error: uErr } = await supabase.auth.getUser(token);
        if (uErr || !user) {
            return errorResponse("Invalid auth token", 401);
        }
        callerUserId = user.id;
    }

    let body: IssuanceBody;
    try {
        body = await req.json();
    } catch {
        return errorResponse("Invalid JSON", 400);
    }
    if (typeof body.usd_amount !== "number" || body.usd_amount <= 0) {
        return errorResponse("usd_amount must be a positive number", 400);
    }
    if (!body.wallet_id && !(body.customer_id && body.business_id)) {
        return errorResponse(
            "Provide wallet_id, or both customer_id and business_id",
            400
        );
    }

    // Resolve the wallet
    let walletQuery = supabase
        .from("wallets")
        .select(
            "id, business_id, customer_id, balance, lifetime_earned, " +
            "businesses!inner(owner_user_id, issuance_rate, archived_at)"
        );
    if (body.wallet_id) {
        walletQuery = walletQuery.eq("id", body.wallet_id);
    } else {
        walletQuery = walletQuery
            .eq("customer_id", body.customer_id!)
            .eq("business_id", body.business_id!);
    }
    const { data: wallet, error: wErr } = await walletQuery.maybeSingle();
    if (wErr || !wallet) {
        return errorResponse("Wallet not found", 404);
    }
    // deno-lint-ignore no-explicit-any
    const biz = (wallet as any).businesses;
    if (biz.archived_at) {
        return errorResponse("Business is archived", 400);
    }

    // Authorization: business owner OR service role
    if (!isServiceRole && biz.owner_user_id !== callerUserId) {
        return errorResponse("Not the business owner", 403);
    }

    // Idempotency: if pos_external_id was used recently, return the prior tx
    if (body.pos_external_id) {
        const { data: prior } = await supabase
            .from("transactions")
            .select("id, lymx_amount")
            .eq("business_id", wallet.business_id)
            .eq("pos_external_id", body.pos_external_id)
            .eq("type", "issuance")
            .maybeSingle();
        if (prior) {
            // Re-fetch wallet for current balance
            const { data: w2 } = await supabase
                .from("wallets")
                .select("balance, lifetime_earned")
                .eq("id", wallet.id)
                .single();
            return jsonResponse({
                transaction_id: prior.id,
                wallet_id: wallet.id,
                lymx_issued: Number(prior.lymx_amount),
                new_balance: Number(w2?.balance ?? wallet.balance),
                lifetime_earned: Number(w2?.lifetime_earned ?? wallet.lifetime_earned),
                idempotent: true,
            });
        }
    }

    // Calculate LYMX to issue
    const rate = Number(biz.issuance_rate) || 5;
    const lymxIssued = Math.floor(body.usd_amount * rate);
    if (lymxIssued <= 0) {
        return errorResponse("Computed LYMX issuance is 0 — check usd_amount", 400);
    }

    // Insert the transaction
    const { data: tx, error: txErr } = await supabase
        .from("transactions")
        .insert({
            type: "issuance",
            wallet_id: wallet.id,
            business_id: wallet.business_id,
            location_id: body.location_id ?? null,
            lymx_amount: lymxIssued,
            usd_basis: body.usd_amount,
            pos_external_id: body.pos_external_id ?? null,
            note: body.note ?? null,
            created_by_user_id: callerUserId,
        })
        .select("id")
        .single();

    if (txErr || !tx) {
        return errorResponse(`Transaction insert failed: ${txErr?.message}`, 500);
    }

    // Update wallet balance + lifetime_earned
    const newBalance = Number(wallet.balance) + lymxIssued;
    const newLifetime = Number(wallet.lifetime_earned) + lymxIssued;
    const { error: uErr } = await supabase
        .from("wallets")
        .update({
            balance: newBalance,
            lifetime_earned: newLifetime,
        })
        .eq("id", wallet.id);

    if (uErr) {
        // The transaction is logged but the wallet is now out of sync.
        // A later reconciliation job will fix it. Log and continue.
        console.error("Wallet update failed (tx id=" + tx.id + "):", uErr);
    }

    return jsonResponse({
        transaction_id: tx.id,
        wallet_id: wallet.id,
        lymx_issued: lymxIssued,
        new_balance: newBalance,
        lifetime_earned: newLifetime,
    }, 201);
});
