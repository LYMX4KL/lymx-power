// =============================================================================
// LYMX Power — Business Signup Bonus Endpoint
// =============================================================================
// POST /functions/v1/business-signup-bonus
//
// Called from welcome.html landing page after a new customer creates their
// LYMX account via a business invite. Issues the signup bonus split between
// LYMX and the business, with full anti-fraud logging.
//
// REQUEST BODY:
//   { user_id, business_slug, idempotency_key, landing_url, user_agent, signup_token }
//
// RESPONSE (200):
//   { success, issuance_id, amount_lymx, lymx_portion, business_portion,
//     admin_status, fraud_flags, wallet_credited }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lymx-api-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
const errorResponse = (msg, status = 400) => json({ error: msg }, status);

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return errorResponse("Method not allowed", 405);

    let body;
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON", 400); }
    const { user_id, business_slug, idempotency_key, landing_url, user_agent, signup_token, inviter_ref } = body || {};
    if (!user_id || !business_slug || !idempotency_key) {
        return errorResponse("Missing required fields: user_id, business_slug, idempotency_key", 400);
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(SUPABASE_URL, SVC_KEY);

    const apiKey = req.headers.get("x-lymx-api-key");
    if (apiKey) {
        const { data: bizByKey } = await supabase
            .from("business_partners")
            .select("slug,active")
            .eq("api_key", apiKey)
            .single();
        if (!bizByKey || !bizByKey.active || bizByKey.slug !== business_slug) {
            return errorResponse("Invalid or mismatched API key for this business", 403);
        }
    }

    const { data: biz, error: bizErr } = await supabase
        .from("business_partners")
        .select("*")
        .eq("slug", business_slug)
        .eq("active", true)
        .single();
    if (bizErr || !biz) return errorResponse("Business not found or inactive: " + business_slug, 404);

    const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(user_id);
    if (userErr || !userData || !userData.user) return errorResponse("User not found", 404);

    // Ensure a customers row exists (so business lookups by phone work immediately).
    // Phone comes from user_metadata.phone (set by welcome.html signup form).
    const { data: existingCustomer } = await supabase
        .from("customers")
        .select("id")
        .eq("user_id", user_id)
        .maybeSingle();
    if (!existingCustomer) {
        const meta = (userData.user.user_metadata || {}) as Record<string, unknown>;
        const phone = (meta.phone as string) || userData.user.phone || null;
        const firstName = (meta.first_name as string) || "";
        const lastName  = (meta.last_name as string) || "";
        const displayName = (firstName || lastName) ? (firstName + " " + lastName).trim() : null;
        await supabase.from("customers").insert({
            user_id,
            phone,
            email: userData.user.email ?? null,
            display_name: displayName,
        });
        // Best-effort — if insert fails (e.g., unique phone), we still proceed.
    }

    const { data: existing } = await supabase
        .from("lymx_issuances")
        .select("*")
        .eq("business_id", biz.id)
        .eq("idempotency_key", idempotency_key)
        .maybeSingle();
    if (existing) {
        return json({
            success: true,
            idempotent_replay: true,
            issuance_id: existing.id,
            amount_lymx: existing.amount_lymx,
            lymx_portion: biz.signup_bonus_from_lymx,
            business_portion: biz.signup_bonus_from_biz,
            admin_status: existing.admin_status,
            fraud_flags: existing.fraud_flags || [],
        });
    }

    const ipHeader = req.headers.get("x-forwarded-for");
    const ipAddress = ipHeader ? ipHeader.split(",")[0].trim() : null;

    await supabase.from("signup_attributions").upsert({
        user_id, business_id: biz.id, business_slug, landing_url, user_agent, signup_token,
        ip_address: ipAddress,
    }, { onConflict: "user_id" });

    const totalLymx = biz.signup_bonus_from_lymx + biz.signup_bonus_from_biz;
    const lymxCostCents = biz.signup_bonus_from_lymx * biz.bonus_cents_per_lymx;
    const businessCostCents = biz.signup_bonus_from_biz * biz.bonus_cents_per_lymx;

    const { data: issuance, error: issueErr } = await supabase
        .from("lymx_issuances")
        .insert({
            recipient_user_id: user_id,
            business_id: biz.id,
            amount_lymx: totalLymx,
            reason: "signup_bonus",
            lymx_cost_cents: lymxCostCents,
            business_cost_cents: businessCostCents,
            transaction_method: "signup",
            verified: true,
            idempotency_key,
            ip_address: ipAddress,
            user_agent,
        })
        .select()
        .single();

    if (issueErr) {
        return json({ success: false, blocked: true, error: issueErr.message }, 403);
    }

    if (issuance.admin_status === "auto") {
        const { error: walletErr } = await supabase.rpc("credit_customer_wallet", {
            p_user_id: user_id,
            p_amount: totalLymx,
            p_reason: "signup_bonus from " + business_slug,
            p_issuance_id: issuance.id,
        });
        if (walletErr) console.error("credit_customer_wallet failed:", walletErr.message);
    }

    // ── Referral bonus: if an inviter_ref was provided, credit BOTH parties 100 LYMX each ──
    let referralResult = null;
    if (inviter_ref) {
        let inviterUserId = null;
        // Try interpreting ref as a UUID directly (auth.users.id OR partners.id)
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(inviter_ref)) {
            // First check: does this UUID exist as a partner_id?
            const { data: byPartnerId } = await supabase
                .from("partners")
                .select("user_id")
                .eq("id", inviter_ref)
                .maybeSingle();
            inviterUserId = byPartnerId?.user_id || inviter_ref; // fall through to treating as raw auth.users.id
        } else if (/^P-?\d{4,8}$/i.test(inviter_ref)) {
            // Partner referral code format (P-NNNNNN)
            const normalized = inviter_ref.toUpperCase().replace(/^P(\d)/, 'P-$1');
            const { data: byPartnerCode } = await supabase
                .from("partners")
                .select("user_id")
                .eq("partner_code", normalized)
                .maybeSingle();
            inviterUserId = byPartnerCode?.user_id || null;
        } else if (/^U-?\d{4,12}$/i.test(inviter_ref)) {
            // Customer share-link format U-XXXX — currently no lookup table; skip silently
            inviterUserId = null;
        } else {
            // Fallback: try as a partners.id lookup
            const { data: partner } = await supabase
                .from("partners")
                .select("user_id")
                .eq("id", inviter_ref)
                .maybeSingle();
            inviterUserId = partner?.user_id || null;
        }


        if (inviterUserId && inviterUserId !== user_id) {
            const { data: refResult, error: refErr } = await supabase.rpc("credit_referral_pair", {
                p_inviter_id: inviterUserId,
                p_invitee_id: user_id,
                p_invite_method: "partner_link",
                p_invite_template: "customer",
                p_landing_url: landing_url,
                p_user_agent: user_agent,
            });
            if (refErr) {
                console.warn("credit_referral_pair failed:", refErr.message);
                referralResult = { success: false, error: refErr.message };
            } else {
                referralResult = refResult;
            }
        }
    }

    return json({
        success: true,
        amount_lymx: totalLymx,
        admin_status: issuance?.admin_status || null,
        idempotency_key,
        referral: referralResult,
    });
});
