// =============================================================================
// LYMX Business Integration API — Earn endpoint
//   POST /functions/v1/business-event
// =============================================================================
// Generic inbound earn event from a business's platform (handoff §5.1).
// A business calls this when an earn event occurs (a fee paid, a signup, a
// promo). LYMX validates the event_type against the business's APPROVED
// earn-event catalog, computes the LYMX per the configured rate, and credits
// the customer's wallet through the CANONICAL issuance ledger
// (public.lymx_issuances — the same pipeline the Module-5 issuance EF uses,
// so the fraud guard trigger + balance view apply unchanged).
//
// Vocabulary: business / partner / customer (3-role rule). No "business partner".
//
// AUTH:  x-lymx-api-key: <business api_key>   (maps to businesses.api_key)
//        Authorization:  Bearer <SUPABASE_ANON_KEY>   (gateway)
//        -> deploy with verify_jwt = FALSE (external callers use the api_key,
//           not a Supabase JWT).
//
// REQUEST BODY:
//   {
//     "event_type": "fee_admin",                // must match an APPROVED catalog entry
//     "amount_usd": 200.00,                      // omit/0 for flat events (e.g. agent_signup)
//     "customer": { "email": "...", "phone": "+1...", "external_id": "..." },  // >=1 identifier
//     "external_ref": "ip-ledger-998877",        // YOUR unique id (idempotency)
//     "occurred_at": "2026-05-30T18:00:00Z"      // optional
//   }
//
// RESPONSE:
//   { ok:true,  status:"issued",   lymx_issued:1000 }
//   { ok:true,  status:"hold",     lymx_issued:1000 }     // flagged; settles after admin review
//   { ok:false, status:"no_wallet", invite_url:"https://getlymx.com/signup.html?claim=<token>" }
//   { ok:false, error:"event_type_not_configured" | "not_integrated" | "missing_identifier"
//             | "invalid_amount" | "business_not_onboarded" }
//
// Idempotent on (business_id, external_ref): a repeat returns the original outcome.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lymx-api-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const INVITE_BASE = "https://getlymx.com/welcome.html";  // 2026-05-31 #A: signup.html did not exist; welcome.html is the real signup

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SB_URL || !SB_KEY) return json({ ok: false, error: "server_misconfigured" }, 500);
    const supabase = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

    // ── 1. Authenticate the business via api_key ───────────────────────────
    const apiKey = req.headers.get("x-lymx-api-key") || "";
    if (!apiKey) return json({ ok: false, error: "missing_api_key" }, 401);

    const { data: biz, error: bizErr } = await supabase
        .from("businesses")
        .select("id, slug, display_name, integration_active, intake_completed_at, identity_match_mode")
        .eq("api_key", apiKey)
        .maybeSingle();
    if (bizErr) return json({ ok: false, error: "auth_lookup_failed" }, 500);
    if (!biz) return json({ ok: false, error: "invalid_api_key" }, 401);
    if (!biz.integration_active) return json({ ok: false, error: "not_integrated" }, 403);
    // Config (catalog + rates) is gated behind contract-signed + fee-paid + intake (§9.3)
    if (!biz.intake_completed_at) return json({ ok: false, error: "business_not_onboarded" }, 403);

    // ── 2. Parse + validate body ───────────────────────────────────────────
    let body: any;
    try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
    const eventType = (body?.event_type || "").trim();
    const externalRef = (body?.external_ref || "").trim();
    const cust = body?.customer || {};
    const email = (cust.email || "").trim().toLowerCase() || null;
    const phone = (cust.phone || "").trim() || null;
    const externalId = (cust.external_id || "").trim() || null;
    const amountUsd = Number(body?.amount_usd || 0);
    const amountUsdCents = Math.round(amountUsd * 100);
    const occurredAt = body?.occurred_at || null;

    if (!eventType) return json({ ok: false, error: "missing_event_type" }, 400);
    if (!externalRef) return json({ ok: false, error: "missing_external_ref" }, 400);
    if (!email && !phone) return json({ ok: false, error: "missing_identifier" }, 400);
    if (amountUsd < 0) return json({ ok: false, error: "invalid_amount" }, 400);

    // ── 3. Idempotency — return the original outcome on a repeat ────────────
    const { data: prior } = await supabase
        .from("business_events")
        .select("status, lymx_issued, claim_id, error_code")
        .eq("business_id", biz.id)
        .eq("external_ref", externalRef)
        .maybeSingle();
    if (prior) {
        if (prior.status === "no_wallet" && prior.claim_id) {
            const { data: pc } = await supabase.from("lymx_pending_claims")
                .select("invite_token").eq("id", prior.claim_id).maybeSingle();
            return json({ ok: false, status: "no_wallet", lymx_issued: 0,
                invite_url: pc ? `${INVITE_BASE}?claim=${pc.invite_token}` : null, replay: true });
        }
        if (prior.status === "rejected")
            return json({ ok: false, error: prior.error_code || "rejected", replay: true });
        return json({ ok: prior.status !== "rejected", status: prior.status,
            lymx_issued: prior.lymx_issued || 0, replay: true });
    }

    // ── 4. Validate event_type against the APPROVED catalog ─────────────────
    const { data: cat } = await supabase
        .from("business_event_catalog")
        .select("event_type, lymx_per_dollar, flat_lymx, redeemable")
        .eq("business_id", biz.id)
        .eq("event_type", eventType)
        .eq("approved", true)
        .eq("active", true)
        .maybeSingle();
    if (!cat) {
        await supabase.from("business_events").insert({
            business_id: biz.id, event_type: eventType, external_ref: externalRef,
            customer_email: email, customer_phone: phone, customer_external_id: externalId,
            amount_usd_cents: amountUsdCents, lymx_issued: 0,
            status: "rejected", error_code: "event_type_not_configured", occurred_at: occurredAt,
        });
        return json({ ok: false, error: "event_type_not_configured" }, 422);
    }

    // ── 5. Compute LYMX from the catalog rate ───────────────────────────────
    const lymx = Math.round(Number(cat.flat_lymx || 0) + amountUsd * Number(cat.lymx_per_dollar || 0));
    if (lymx <= 0) {
        await supabase.from("business_events").insert({
            business_id: biz.id, event_type: eventType, external_ref: externalRef,
            customer_email: email, customer_phone: phone, customer_external_id: externalId,
            amount_usd_cents: amountUsdCents, lymx_issued: 0,
            status: "rejected", error_code: "invalid_amount", occurred_at: occurredAt,
        });
        return json({ ok: false, error: "invalid_amount" }, 422);
    }

    // ── 6. Resolve the customer's wallet (auth user) by email/phone ─────────
    let recipientUserId: string | null = null;
    if (email) {
        const { data } = await supabase.from("customers")
            .select("user_id").ilike("email", email).is("archived_at", null)
            .not("user_id", "is", null).limit(1);
        if (data && data.length) recipientUserId = data[0].user_id;
    }
    if (!recipientUserId && phone) {
        const { data } = await supabase.from("customers")
            .select("user_id").eq("phone", phone).is("archived_at", null)
            .not("user_id", "is", null).limit(1);
        if (data && data.length) recipientUserId = data[0].user_id;
    }

    // ── 7a. No wallet → 24h pending claim + invite link (§11) ───────────────
    if (!recipientUserId) {
        const { data: claim, error: claimErr } = await supabase
            .from("lymx_pending_claims")
            .insert({
                business_id: biz.id, event_type: eventType,
                customer_email: email, customer_phone: phone,
                lymx_amount: lymx, amount_usd_cents: amountUsdCents, external_ref: externalRef,
            })
            .select("id, invite_token")
            .single();
        if (claimErr) return json({ ok: false, error: "claim_failed", detail: claimErr.message }, 500);
        await supabase.from("business_events").insert({
            business_id: biz.id, event_type: eventType, external_ref: externalRef,
            customer_email: email, customer_phone: phone, customer_external_id: externalId,
            amount_usd_cents: amountUsdCents, lymx_issued: 0,
            status: "no_wallet", claim_id: claim.id, occurred_at: occurredAt,
        });
        return json({ ok: false, status: "no_wallet", lymx_issued: 0,
            invite_url: `${INVITE_BASE}?claim=${claim.invite_token}` });
    }

    // ── 7b. Wallet found → issue through the canonical ledger ───────────────
    // Mirrors the Module-5 issuance EF insert; the guard_lymx_issuance trigger
    // (mig 099) applies fraud rules and may set admin_status='pending_review'.
    let issuanceId: string | null = null;
    let adminStatus = "auto";
    const ins = await supabase
        .from("lymx_issuances")
        .insert({
            recipient_user_id: recipientUserId,
            business_id: biz.id,
            amount_lymx: lymx,
            reason: "business_event",   // fixed ledger reason; specific event_type lives in business_events
            transaction_amount_cents: amountUsdCents || null,
            transaction_method: "webhook",  // inbound push from the business's platform (whitelisted channel)
            verified: true,
            admin_status: "auto",
            idempotency_key: externalRef,
        })
        .select("id, admin_status")
        .single();
    if (ins.error) {
        // Unique collision on (business_id, idempotency_key) = concurrent retry: re-read.
        const { data: winner } = await supabase.from("lymx_issuances")
            .select("id, admin_status, amount_lymx")
            .eq("business_id", biz.id).eq("idempotency_key", externalRef).maybeSingle();
        if (winner) { issuanceId = winner.id; adminStatus = winner.admin_status; }
        else return json({ ok: false, error: "issue_failed", detail: ins.error.message }, 500);
    } else {
        issuanceId = ins.data.id; adminStatus = ins.data.admin_status;
    }

    const evStatus = adminStatus === "auto" || adminStatus === "approved" ? "issued" : "hold";
    await supabase.from("business_events").insert({
        business_id: biz.id, event_type: eventType, external_ref: externalRef,
        recipient_user_id: recipientUserId, customer_email: email, customer_phone: phone,
        customer_external_id: externalId, amount_usd_cents: amountUsdCents, lymx_issued: lymx,
        status: evStatus, issuance_id: issuanceId, occurred_at: occurredAt,
    });

    return json({ ok: true, status: evStatus, lymx_issued: lymx });
});
