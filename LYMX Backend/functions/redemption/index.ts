// =============================================================================
// LYMX Power — Redemption Endpoint
// =============================================================================
// POST /functions/v1/redemption
//
// A customer pays for part of a purchase with LYMX. Subject to the 80% rule:
// a maximum of 80% of any single transaction (`redemption_cap_pct` per business)
// can be paid with LYMX.
//
// MATH:
//   1 LYMX  = $0.01 / redemption_rate          (default rate 5 → 1 LYMX = $0.002)
//   max LYMX redeemable = usd_total * cap_pct * 100 * redemption_rate
//     (with defaults: $10 bill × 0.80 × 100 × 5 = 4000 LYMX max)
//   usd_paid_via_lymx = lymx_redeemed / (redemption_rate * 100)
//
// AUTH: Business owner OR service role (same pattern as issuance).
//
// REQUEST BODY (JSON):
// {
//   "wallet_id": "uuid",          // OR customer_id + business_id
//   "customer_id": "uuid",
//   "business_id": "uuid",
//   "location_id": "uuid",        // optional
//   "usd_total": 10.00,           // total bill BEFORE LYMX is applied
//   "lymx_to_redeem": 200,        // optional; if omitted we redeem the
//                                 //   MAX allowed (= min(balance, 80% cap))
//   "pos_external_id": "...",     // optional, idempotency key
//   "note": "..."                 // optional
// }
//
// RESPONSE (201):
// {
//   "transaction_id": "uuid",
//   "wallet_id": "uuid",
//   "lymx_redeemed": 200,
//   "usd_paid_via_lymx": 0.40,
//   "usd_remaining_to_charge": 9.60,
//   "new_balance": 50,
//   "lifetime_spent": 200
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

interface RedemptionBody {
    wallet_id?: string;
    customer_id?: string;
    business_id?: string;
    location_id?: string;
    usd_total: number;
    lymx_to_redeem?: number;
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

    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } }
    );

    // Identify caller: business owner OR service role.
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

    let body: RedemptionBody;
    try {
        body = await req.json();
    } catch {
        return errorResponse("Invalid JSON", 400);
    }
    if (typeof body.usd_total !== "number" || body.usd_total <= 0) {
        return errorResponse("usd_total must be a positive number", 400);
    }
    if (!body.wallet_id && !(body.customer_id && body.business_id)) {
        return errorResponse(
            "Provide wallet_id, or both customer_id and business_id",
            400
        );
    }
    if (body.lymx_to_redeem !== undefined &&
        (typeof body.lymx_to_redeem !== "number" || body.lymx_to_redeem <= 0)) {
        return errorResponse("lymx_to_redeem must be a positive number", 400);
    }

    // Resolve the wallet (with joined business config)
    let walletQuery = supabase
        .from("wallets")
        .select(
            "id, business_id, customer_id, balance, lifetime_earned, lifetime_spent, " +
            "businesses!inner(owner_user_id, redemption_rate, redemption_cap_pct, archived_at)"
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
    if (!isServiceRole && biz.owner_user_id !== callerUserId) {
        return errorResponse("Not the business owner", 403);
    }

    // Idempotency: same pos_external_id → return prior redemption
    if (body.pos_external_id) {
        const { data: prior } = await supabase
            .from("transactions")
            .select("id, lymx_amount, usd_basis")
            .eq("business_id", wallet.business_id)
            .eq("pos_external_id", body.pos_external_id)
            .eq("type", "redemption")
            .maybeSingle();
        if (prior) {
            const { data: w2 } = await supabase
                .from("wallets")
                .select("balance, lifetime_spent")
                .eq("id", wallet.id)
                .single();
            const lymx = Number(prior.lymx_amount);
            const rate = Number(biz.redemption_rate) || 5;
            const usd_paid = lymx / (rate * 100);
            return jsonResponse({
                transaction_id: prior.id,
                wallet_id: wallet.id,
                lymx_redeemed: lymx,
                usd_paid_via_lymx: Number(usd_paid.toFixed(2)),
                usd_remaining_to_charge: Number((body.usd_total - usd_paid).toFixed(2)),
                new_balance: Number(w2?.balance ?? wallet.balance),
                lifetime_spent: Number(w2?.lifetime_spent ?? wallet.lifetime_spent),
                idempotent: true,
            });
        }
    }

    // 80% RULE — cap LYMX redemption at cap_pct of usd_total
    // max_lymx_allowed = usd_total * cap_pct * 100 * redemption_rate
    const rate = Number(biz.redemption_rate) || 5;
    const capPct = Number(biz.redemption_cap_pct) || 0.80;
    const maxLymxByCap = Math.floor(body.usd_total * capPct * 100 * rate);
    const balance = Number(wallet.balance);
    const maxLymxAvailable = Math.min(balance, maxLymxByCap);

    // Determine actual amount to redeem
    let lymxRedeemed: number;
    if (body.lymx_to_redeem !== undefined) {
        const requested = Math.floor(body.lymx_to_redeem);
        if (requested > balance) {
            return errorResponse(
                `Insufficient balance: requested ${requested} but balance is ${balance}`,
                400
            );
        }
        if (requested > maxLymxByCap) {
            return errorResponse(
                `Exceeds 80% rule: requested ${requested} but max is ${maxLymxByCap} ` +
                `(${capPct * 100}% of $${body.usd_total} at rate ${rate})`,
                400
            );
        }
        lymxRedeemed = requested;
    } else {
        // Default: redeem the maximum allowed
        lymxRedeemed = maxLymxAvailable;
    }
    if (lymxRedeemed <= 0) {
        return errorResponse(
            "Computed LYMX redemption is 0 — wallet has no balance or usd_total too small",
            400
        );
    }

    const usdPaidViaLymx = lymxRedeemed / (rate * 100);
    const usdRemaining = body.usd_total - usdPaidViaLymx;

    // Insert the transaction (type=redemption)
    const { data: tx, error: txErr } = await supabase
        .from("transactions")
        .insert({
            type: "redemption",
            wallet_id: wallet.id,
            business_id: wallet.business_id,
            location_id: body.location_id ?? null,
            lymx_amount: lymxRedeemed,
            usd_basis: body.usd_total,
            pos_external_id: body.pos_external_id ?? null,
            note: body.note ?? null,
            created_by_user_id: callerUserId,
        })
        .select("id")
        .single();

    if (txErr || !tx) {
        return errorResponse(`Transaction insert failed: ${txErr?.message}`, 500);
    }

    // Update wallet balance + lifetime_spent
    const newBalance = balance - lymxRedeemed;
    const newSpent = Number(wallet.lifetime_spent) + lymxRedeemed;
    const { error: uErr } = await supabase
        .from("wallets")
        .update({
            balance: newBalance,
            lifetime_spent: newSpent,
        })
        .eq("id", wallet.id);

    if (uErr) {
        // Transaction is logged but wallet is out of sync — log + reconcile later
        console.error("Wallet update failed (tx id=" + tx.id + "):", uErr);
    }

    return jsonResponse({
        transaction_id: tx.id,
        wallet_id: wallet.id,
        lymx_redeemed: lymxRedeemed,
        usd_paid_via_lymx: Number(usdPaidViaLymx.toFixed(2)),
        usd_remaining_to_charge: Number(usdRemaining.toFixed(2)),
        new_balance: newBalance,
        lifetime_spent: newSpent,
    }, 201);
});
