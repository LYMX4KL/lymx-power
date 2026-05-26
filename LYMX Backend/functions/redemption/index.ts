// =============================================================================
// LYMX Power — Redemption Endpoint (Module 5: unified pipeline)
// =============================================================================
// POST /functions/v1/redemption
//
// A customer pays for part of a purchase with LYMX. Subject to the 80% rule:
// at most `redemption_cap_pct` (default 80%) of any single transaction can be
// paid with LYMX.
//
// MATH:
//   1 LYMX = $0.01 / redemption_rate              (default 5 → 1 LYMX = $0.002)
//   max LYMX redeemable = usd_total * cap_pct * 100 * redemption_rate
//     (with defaults: $10 × 0.80 × 100 × 5 = 4000 LYMX max)
//   usd_paid_via_lymx = lymx_redeemed / (redemption_rate * 100)
//
// MODULE 5 REWRITE (2026-05-26):
//   Pre-Module-5 this EF read `wallets.balance` and wrote to `transactions`.
//   With Module 5 unification, balance is computed from SUM(lymx_issuances)
//   via the canonical pipeline, and the redemption is recorded as a NEGATIVE
//   amount_lymx row with reason='redemption'. v_my_lymx_balance handles the
//   negative-sum math transparently.
//
// AUTH: Business owner (auth.uid = businesses.owner_user_id) OR service_role.
//
// REQUEST BODY (JSON):
//   {
//     "business_id":       "uuid",                  // required
//     "recipient_user_id": "uuid",                  // preferred — auth.users.id
//     "customer_id":       "uuid",                  // legacy — public.customers.id
//     "wallet_id":         "uuid",                  // legacy — public.wallets.id (deprecated)
//     "recipient_phone":   "+17025551234",          // legacy lookup
//     "recipient_email":   "x@y.com",               // legacy lookup
//     "usd_total":         10.00,                   // total bill BEFORE LYMX
//     "lymx_to_redeem":    200,                     // optional; defaults to max allowed
//     "pos_external_id":   "sq_xyz123",             // optional idempotency key
//     "transaction_method": "pos",                  // optional
//     "note":              "..."
//   }
//
// RESPONSE (201):
//   {
//     "ok": true,
//     "redemption_id":    "uuid",                   // lymx_issuances.id
//     "recipient_user_id": "uuid",
//     "business_id":      "uuid",
//     "lymx_redeemed":    200,
//     "usd_paid_via_lymx": 0.40,
//     "usd_remaining_to_charge": 9.60,
//     "new_balance":      50,
//     "idempotent":       false
//   }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const errorResponse = (m: string, s = 400) => jsonResponse({ error: m }, s);

interface RedemptionBody {
    business_id?: string;
    recipient_user_id?: string;
    customer_id?: string;
    wallet_id?: string;
    recipient_phone?: string;
    recipient_email?: string;
    usd_total: number;
    lymx_to_redeem?: number;
    pos_external_id?: string;
    transaction_method?: string;
    note?: string;
    ip_address?: string;
}

function getJwtRole(jwt: string): string | null {
    try {
        const parts = jwt.split(".");
        if (parts.length !== 3) return null;
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        return payload.role ?? null;
    } catch { return null; }
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST")    return errorResponse("Method not allowed", 405);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return errorResponse("Missing Authorization header", 401);
    const token = authHeader.replace("Bearer ", "");

    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } }
    );

    const isServiceRole = getJwtRole(token) === "service_role";
    let callerUserId: string | null = null;
    if (!isServiceRole) {
        const { data: { user }, error: uErr } = await supabase.auth.getUser(token);
        if (uErr || !user) return errorResponse("Invalid auth token", 401);
        callerUserId = user.id;
    }

    let body: RedemptionBody;
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON", 400); }
    if (typeof body.usd_total !== "number" || body.usd_total <= 0) {
        return errorResponse("usd_total must be a positive number", 400);
    }
    if (!body.business_id) {
        return errorResponse("business_id is required", 400);
    }
    if (body.lymx_to_redeem !== undefined && (typeof body.lymx_to_redeem !== "number" || body.lymx_to_redeem <= 0)) {
        return errorResponse("lymx_to_redeem must be a positive number", 400);
    }

    // ─── 1. Resolve business + authorize ────────────────────────────────────
    const { data: biz, error: bizErr } = await supabase
        .from("businesses")
        .select("id, slug, display_name, owner_user_id, redemption_rate, redemption_cap_pct, archived_at, approval_status, demo_only")
        .eq("id", body.business_id)
        .maybeSingle();
    if (bizErr || !biz) return errorResponse("Business not found", 404);
    if (biz.archived_at) return errorResponse("Business is archived", 400);
    if (biz.demo_only) return errorResponse("Demo businesses cannot accept real LYMX redemptions", 400);
    if (!isServiceRole && biz.owner_user_id !== callerUserId) {
        return errorResponse("Not the business owner", 403);
    }

    // ─── 2. Resolve recipient_user_id (multiple legacy paths) ───────────────
    let recipientUserId: string | null = body.recipient_user_id || null;
    if (!recipientUserId && body.customer_id) {
        const { data: c } = await supabase.from("customers").select("user_id").eq("id", body.customer_id).maybeSingle();
        if (c && c.user_id) recipientUserId = c.user_id;
    }
    if (!recipientUserId && body.wallet_id) {
        const { data: w } = await supabase.from("wallets").select("customer_id").eq("id", body.wallet_id).maybeSingle();
        if (w && w.customer_id) {
            const { data: c } = await supabase.from("customers").select("user_id").eq("id", w.customer_id).maybeSingle();
            if (c && c.user_id) recipientUserId = c.user_id;
        }
    }
    if (!recipientUserId && body.recipient_phone) {
        const { data: c } = await supabase.from("customers").select("user_id").eq("phone", body.recipient_phone).maybeSingle();
        if (c && c.user_id) recipientUserId = c.user_id;
    }
    if (!recipientUserId && body.recipient_email) {
        const { data: c } = await supabase.from("customers").select("user_id").eq("email", body.recipient_email.toLowerCase().trim()).maybeSingle();
        if (c && c.user_id) recipientUserId = c.user_id;
    }
    if (!recipientUserId) {
        return errorResponse("Could not resolve a customer. Pass recipient_user_id (preferred), customer_id, recipient_phone, or recipient_email.", 404);
    }

    // ─── 3. Verification gate (Kenny 2026-05-14) ────────────────────────────
    // Customer must be admin-verified before they can SPEND LYMX. Signup is
    // friction-free; spending is held until verification.
    const { data: cust } = await supabase
        .from("customers")
        .select("user_id, verified_at, display_name")
        .eq("user_id", recipientUserId)
        .maybeSingle();
    if (cust && !cust.verified_at) {
        return errorResponse(
            `Customer ${cust.display_name || cust.user_id} is not yet verified. LYMX spending is held until admin verification in admin-verifications.html.`,
            403,
        );
    }

    // ─── 4. Compute current balance (from lymx_issuances SUM) ───────────────
    const { data: balRows, error: balErr } = await supabase
        .from("lymx_issuances")
        .select("amount_lymx")
        .eq("recipient_user_id", recipientUserId)
        .in("admin_status", ["auto", "approved"]);
    if (balErr) return errorResponse(`Balance read failed: ${balErr.message}`, 500);
    const balance = (Array.isArray(balRows) ? balRows : []).reduce((s, r) => s + Number((r as any).amount_lymx || 0), 0);

    // ─── 5. Idempotency: same biz + same idempotency_key → return prior row ──
    const idempotencyKey = body.pos_external_id
        ? `pos_redeem_${body.pos_external_id}`
        : `redeem_${recipientUserId.slice(0, 8)}_${Math.round(body.usd_total * 100)}_${Math.floor(Date.now() / 60000)}`;
    const { data: prior } = await supabase
        .from("lymx_issuances")
        .select("id, amount_lymx, recipient_user_id, transaction_amount_cents")
        .eq("business_id", biz.id)
        .eq("idempotency_key", idempotencyKey)
        .eq("reason", "redemption")
        .maybeSingle();
    if (prior) {
        const lymx = Math.abs(Number(prior.amount_lymx));
        const rate = Number(biz.redemption_rate) || 5;
        const usd_paid = lymx / (rate * 100);
        return jsonResponse({
            ok: true,
            redemption_id: prior.id,
            recipient_user_id: prior.recipient_user_id,
            business_id: biz.id,
            lymx_redeemed: lymx,
            usd_paid_via_lymx: Number(usd_paid.toFixed(2)),
            usd_remaining_to_charge: Number((body.usd_total - usd_paid).toFixed(2)),
            new_balance: balance,
            idempotent: true,
        });
    }

    // ─── 6. 80% rule + balance check ────────────────────────────────────────
    const rate   = Number(biz.redemption_rate) || 5;
    const capPct = Number(biz.redemption_cap_pct) || 0.80;
    const maxLymxByCap   = Math.floor(body.usd_total * capPct * 100 * rate);
    const maxLymxAllowed = Math.min(balance, maxLymxByCap);

    let lymxRedeemed: number;
    if (body.lymx_to_redeem !== undefined) {
        const requested = Math.floor(body.lymx_to_redeem);
        if (requested > balance) {
            return errorResponse(`Insufficient balance: requested ${requested} but balance is ${balance}`, 400);
        }
        if (requested > maxLymxByCap) {
            return errorResponse(
                `Exceeds 80% rule: requested ${requested} but max is ${maxLymxByCap} (${capPct * 100}% of $${body.usd_total} at rate ${rate})`,
                400,
            );
        }
        lymxRedeemed = requested;
    } else {
        lymxRedeemed = maxLymxAllowed;
    }
    if (lymxRedeemed <= 0) {
        return errorResponse("Computed LYMX redemption is 0 — balance is empty or usd_total too small", 400);
    }

    const usdPaidViaLymx = lymxRedeemed / (rate * 100);
    const usdRemaining   = Math.max(0, body.usd_total - usdPaidViaLymx);

    // ─── 7. INSERT redemption row (NEGATIVE amount_lymx) ────────────────────
    const { data: ins, error: insErr } = await supabase
        .from("lymx_issuances")
        .insert({
            recipient_user_id: recipientUserId,
            business_id:       biz.id,
            issuing_user_id:   callerUserId,
            amount_lymx:       -lymxRedeemed,           // NEGATIVE so SUM naturally subtracts
            reason:            "redemption",
            lymx_cost_cents:   0,
            business_cost_cents: 0,
            transaction_amount_cents: Math.round(body.usd_total * 100),
            transaction_method: body.transaction_method || "pos",
            verified:          true,
            admin_status:      "auto",
            idempotency_key:   idempotencyKey,
            ip_address:        body.ip_address || null,
            user_agent:        req.headers.get("user-agent") || "redemption-fn",
        })
        .select("id")
        .single();

    if (insErr || !ins) {
        // Unique-constraint race fallback (same idempotency key + biz)
        if (insErr && (insErr.code === "23505" || /duplicate key/i.test(insErr.message || ""))) {
            const { data: winner } = await supabase
                .from("lymx_issuances")
                .select("id, amount_lymx")
                .eq("business_id", biz.id)
                .eq("idempotency_key", idempotencyKey)
                .maybeSingle();
            if (winner) {
                const lymx = Math.abs(Number(winner.amount_lymx));
                const usd = lymx / (rate * 100);
                return jsonResponse({
                    ok: true,
                    redemption_id: winner.id,
                    recipient_user_id: recipientUserId,
                    business_id: biz.id,
                    lymx_redeemed: lymx,
                    usd_paid_via_lymx: Number(usd.toFixed(2)),
                    usd_remaining_to_charge: Number((body.usd_total - usd).toFixed(2)),
                    new_balance: balance,
                    idempotent: true,
                    race_resolved: true,
                });
            }
        }
        return errorResponse(`Redemption insert failed: ${insErr?.message}`, 500);
    }

    return jsonResponse({
        ok: true,
        redemption_id: ins.id,
        recipient_user_id: recipientUserId,
        business_id: biz.id,
        lymx_redeemed: lymxRedeemed,
        usd_paid_via_lymx: Number(usdPaidViaLymx.toFixed(2)),
        usd_remaining_to_charge: Number(usdRemaining.toFixed(2)),
        new_balance: balance - lymxRedeemed,
        idempotent: false,
    }, 201);
});
