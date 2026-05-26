// =============================================================================
// LYMX Power — Issuance Endpoint (Module 5: unified pipeline)
// =============================================================================
// POST /functions/v1/issuance
//
// A business issues LYMX to a customer based on a $ purchase.
//   LYMX_issued = round( usd_amount * business.issuance_rate )   (default 5/$1)
//
// MODULE 5 REWRITE (2026-05-26):
//   Pre-Module-5 this EF wrote to public.transactions + public.wallets — two
//   tables that nothing read from (v_my_lymx_balance reads lymx_issuances).
//   The result: every POS issuance was invisible to the customer.
//
//   Post-Module-5 this EF writes a single row to public.lymx_issuances (the
//   canonical pipeline, 51 production rows already, view-backed). The wallets
//   "pre-existing row required" 404 is gone: the issuance just inserts.
//
// AUTH:
//   - Authenticated business owner (auth.uid() = businesses.owner_user_id), OR
//   - service_role (POS integrations / admin tools / internal backfills)
//
// REQUEST HEADERS:
//   Authorization: Bearer <user_jwt or service_role_key>
//
// REQUEST BODY (JSON):
//   {
//     "business_id":     "uuid",        // required
//     "recipient_user_id": "uuid",      // preferred — auth.users.id of the customer
//     "customer_id":     "uuid",        // legacy — public.customers.id; we resolve to user_id
//     "recipient_phone": "+17025551234",// legacy — phone lookup against customers
//     "recipient_email": "x@y.com",     // legacy — email lookup against customers
//     "usd_amount":      12.50,         // required, positive
//     "pos_external_id": "sq_abc123",   // optional, idempotency key
//     "transaction_method": "pos",      // optional, defaults to "pos"
//     "note":            "string",      // optional
//     "ip_address":      "1.2.3.4"      // optional, for fraud audit
//   }
//
// RESPONSE (200):
//   {
//     "ok": true,
//     "issuance_id":  "uuid",
//     "recipient_user_id": "uuid",
//     "business_id":  "uuid",
//     "lymx_issued":  63,
//     "new_balance":  1042,
//     "idempotent":   false             // true if a prior call returned the same row
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
    new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
const errorResponse = (message: string, status = 400) => jsonResponse({ error: message }, status);

interface IssuanceBody {
    business_id?: string;
    recipient_user_id?: string;
    customer_id?: string;            // legacy: public.customers.id
    wallet_id?: string;              // legacy: public.wallets.id (deprecated)
    recipient_phone?: string;
    recipient_email?: string;
    usd_amount: number;
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

    let body: IssuanceBody;
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON", 400); }
    if (typeof body.usd_amount !== "number" || body.usd_amount <= 0) {
        return errorResponse("usd_amount must be a positive number", 400);
    }
    if (!body.business_id) {
        return errorResponse("business_id is required", 400);
    }

    // ─── 1. Resolve business + authorize caller ────────────────────────────
    const { data: biz, error: bizErr } = await supabase
        .from("businesses")
        .select("id, slug, display_name, owner_user_id, issuance_rate, archived_at, approval_status, demo_only")
        .eq("id", body.business_id)
        .maybeSingle();
    if (bizErr || !biz) return errorResponse("Business not found", 404);
    if (biz.archived_at) return errorResponse("Business is archived", 400);
    if (biz.demo_only) return errorResponse("Demo businesses cannot issue real LYMX", 400);
    if (!isServiceRole && biz.approval_status !== "approved") {
        return errorResponse(
            "Business is not approved yet. Your application is " + (biz.approval_status || "pending") +
            " — once Kenny approves your account (usually within 24 hours), you can start issuing LYMX.",
            403
        );
    }
    if (!isServiceRole && biz.owner_user_id !== callerUserId) {
        return errorResponse("Not the business owner", 403);
    }

    // ─── 2. Resolve recipient_user_id (multiple legacy paths) ──────────────
    let recipientUserId: string | null = body.recipient_user_id || null;

    if (!recipientUserId && body.customer_id) {
        const { data: c } = await supabase
            .from("customers")
            .select("user_id")
            .eq("id", body.customer_id)
            .maybeSingle();
        if (c && c.user_id) recipientUserId = c.user_id;
    }
    if (!recipientUserId && body.wallet_id) {
        // Pre-Module-5 legacy: wallet → customer_id → user_id. The wallets
        // table is deprecated but if a stale POS still passes wallet_id, try
        // to honor it.
        const { data: w } = await supabase
            .from("wallets")
            .select("customer_id")
            .eq("id", body.wallet_id)
            .maybeSingle();
        if (w && w.customer_id) {
            const { data: c } = await supabase
                .from("customers")
                .select("user_id")
                .eq("id", w.customer_id)
                .maybeSingle();
            if (c && c.user_id) recipientUserId = c.user_id;
        }
    }
    if (!recipientUserId && body.recipient_phone) {
        const { data: c } = await supabase
            .from("customers")
            .select("user_id")
            .eq("phone", body.recipient_phone)
            .maybeSingle();
        if (c && c.user_id) recipientUserId = c.user_id;
    }
    if (!recipientUserId && body.recipient_email) {
        const { data: c } = await supabase
            .from("customers")
            .select("user_id")
            .eq("email", body.recipient_email.toLowerCase().trim())
            .maybeSingle();
        if (c && c.user_id) recipientUserId = c.user_id;
    }

    if (!recipientUserId) {
        return errorResponse(
            "Could not resolve a customer for this issuance. Pass recipient_user_id (preferred), customer_id, recipient_phone, or recipient_email. The customer must have signed up first via welcome.html?biz=" + biz.slug,
            404
        );
    }

    // Refuse self-issuance (a biz owner can't pay themselves with their own LYMX).
    // The audit (Module 5 fraud guards) flagged this as a real anti-pattern.
    if (recipientUserId === biz.owner_user_id) {
        return errorResponse(
            "A business owner cannot issue LYMX to themselves — that's classified as self-dealing.",
            400
        );
    }

    // ─── 3. Compute amount + idempotency key ───────────────────────────────
    const rate = Number(biz.issuance_rate) || 5;
    const lymxIssued = Math.floor(body.usd_amount * rate);
    if (lymxIssued <= 0) {
        return errorResponse("Computed LYMX issuance is 0 — check usd_amount or issuance_rate", 400);
    }
    const usdAmountCents = Math.round(body.usd_amount * 100);

    // Idempotency: prefer POS-supplied key, else synthesize one that's stable
    // for "same biz, same customer, same cents, same minute" so retry-storms
    // on flaky POS connections don't double-credit.
    const idempotencyKey = body.pos_external_id
        ? `pos_${body.pos_external_id}`
        : `txn_${recipientUserId.slice(0, 8)}_${usdAmountCents}_${Math.floor(Date.now() / 60000)}`;

    // Idempotency check — same biz + same key returns the prior row.
    const { data: prior } = await supabase
        .from("lymx_issuances")
        .select("id, amount_lymx, recipient_user_id")
        .eq("business_id", biz.id)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
    if (prior) {
        const { data: bal } = await supabase.rpc("get_my_lymx_balance_for", { p_user_id: prior.recipient_user_id })
            .catch(() => ({ data: null }));
        return jsonResponse({
            ok: true,
            issuance_id: prior.id,
            recipient_user_id: prior.recipient_user_id,
            business_id: biz.id,
            lymx_issued: Number(prior.amount_lymx),
            new_balance: bal != null ? Number(bal) : null,
            idempotent: true,
        });
    }

    // ─── 4. INSERT lymx_issuances row ──────────────────────────────────────
    const { data: ins, error: insErr } = await supabase
        .from("lymx_issuances")
        .insert({
            recipient_user_id: recipientUserId,
            business_id:       biz.id,
            issuing_user_id:   callerUserId,
            amount_lymx:       lymxIssued,
            reason:            "transaction",
            lymx_cost_cents:   0,
            // Module 5 design: transaction issuances don't auto-bill the biz;
            // biz pays for LYMX via Stripe billing on a separate monthly cadence,
            // not per-issuance. Keeping business_cost_cents = 0 prevents the
            // auto_bill_business_for_issuance trigger from firing.
            business_cost_cents: 0,
            transaction_amount_cents: usdAmountCents,
            transaction_method: body.transaction_method || "pos",
            verified:          true,
            admin_status:      "auto",
            idempotency_key:   idempotencyKey,
            ip_address:        body.ip_address || null,
            user_agent:        req.headers.get("user-agent") || "issuance-fn",
        })
        .select("id")
        .single();

    if (insErr || !ins) {
        // Unique-constraint collision on (business_id, idempotency_key) is the
        // race-condition fallback path — re-fetch and return the winner row.
        if (insErr && (insErr.code === "23505" || /duplicate key/i.test(insErr.message || ""))) {
            const { data: winner } = await supabase
                .from("lymx_issuances")
                .select("id, amount_lymx, recipient_user_id")
                .eq("business_id", biz.id)
                .eq("idempotency_key", idempotencyKey)
                .maybeSingle();
            if (winner) {
                return jsonResponse({
                    ok: true,
                    issuance_id: winner.id,
                    recipient_user_id: winner.recipient_user_id,
                    business_id: biz.id,
                    lymx_issued: Number(winner.amount_lymx),
                    new_balance: null,
                    idempotent: true,
                    race_resolved: true,
                });
            }
        }
        return errorResponse(`Issuance insert failed: ${insErr?.message}`, 500);
    }

    // ─── 5. Compute new balance (best-effort — read failure doesn't fail issuance) ──
    let newBalance: number | null = null;
    try {
        // Use the RPC if available; otherwise fall back to a direct SUM().
        // The get_my_lymx_balance() RPC is auth.uid()-scoped, so it only works
        // for the calling user. For the business owner calling on behalf of the
        // customer we need a separate query.
        const { data: balRows } = await supabase
            .from("lymx_issuances")
            .select("amount_lymx")
            .eq("recipient_user_id", recipientUserId)
            .in("admin_status", ["auto", "approved"]);
        if (Array.isArray(balRows)) {
            newBalance = balRows.reduce((s, r) => s + Number((r as any).amount_lymx || 0), 0);
        }
    } catch (e) {
        console.warn("[issuance] balance read failed (non-fatal):", (e as Error).message);
    }

    return jsonResponse({
        ok: true,
        issuance_id: ins.id,
        recipient_user_id: recipientUserId,
        business_id: biz.id,
        lymx_issued: lymxIssued,
        new_balance: newBalance,
        idempotent: false,
    }, 201);
});
