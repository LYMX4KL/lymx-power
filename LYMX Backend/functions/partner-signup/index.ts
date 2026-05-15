// =============================================================================
// LYMX Power — Partner Sign-up Endpoint
// =============================================================================
// POST /functions/v1/partner-signup
//
// Self-serve partner application. Creates an auth.users row + public.partners
// row in one transaction. If a sponsor_partner_id is provided (from a referring
// partner's invite link), the new partner's sponsor_partner_id is set so MGC
// commission flow attributes overrides correctly.
//
// REQUEST BODY:
// {
//   "owner_email": "helen@example.com",
//   "owner_password": "min10chars",
//   "first_name": "Helen",
//   "last_name": "Liu",
//   "phone": "+17025551234",                 // optional
//   "city": "Las Vegas",                     // optional
//   "state": "NV",                           // optional
//   "zip": "89101",                          // optional
//   "sponsor_partner_id": "uuid-or-code",    // optional — from ?ref= URL param
//   "why": "Why I want to be a partner",     // optional
//   "background": "real_estate",             // optional
//   "extra": "LinkedIn / referral list",     // optional
//   "agreed_to_compensation": true,
//   "agreed_to_pyramid_disclosure": true,
//   "agreed_to_1099_status": true,
//   "agreed_to_tos": true
// }
//
// RESPONSE (201):
// {
//   "user_id": "uuid",
//   "partner_id": "uuid",
//   "sponsor_partner_id": "uuid" | null,
//   "is_founding_25": false,
//   "founding_25_rank": null
// }
//
// IMPORTANT: This function uses service_role to bypass RLS so we can
// create both the auth.users row and the public.partners row atomically.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// --- CORS + response helpers ----------------------------------------------
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

// --- Body shape ------------------------------------------------------------
interface PartnerSignupBody {
    owner_email?: string;     // OPTIONAL — but at least one of (email, phone) required
    owner_password: string;
    first_name: string;
    last_name: string;
    phone?: string;
    country_code?: string;    // ISO 3166-1 alpha-2, e.g. 'US', 'CA', 'GB'
    city?: string;
    state?: string;           // US only
    zip?: string;             // US only
    region?: string;          // international: free-text region/postal
    sponsor_partner_id?: string;
    why?: string;
    background?: string;
    extra?: string;
    agreed_to_compensation?: boolean;
    agreed_to_pyramid_disclosure?: boolean;
    agreed_to_1099_status?: boolean;
    agreed_to_tos?: boolean;
}

function validate(body: PartnerSignupBody): string | null {
    // Email is no longer strictly required — but if absent, phone must be present.
    // Kenny 2026-05-14: international Partners can sign up with phone OR email.
    const hasEmail = !!(body.owner_email && /^\S+@\S+\.\S+$/.test(body.owner_email));
    const hasPhone = !!(body.phone && body.phone.trim().length >= 7);
    if (!hasEmail && !hasPhone) {
        return "Please provide an email address or a phone number";
    }
    if (body.owner_email && !/^\S+@\S+\.\S+$/.test(body.owner_email)) {
        return "Email format looks wrong — try again";
    }
    if (!body.owner_password || body.owner_password.length < 10) {
        return "owner_password must be at least 10 characters";
    }
    if (!body.first_name || body.first_name.trim().length === 0) {
        return "first_name is required";
    }
    if (!body.last_name || body.last_name.trim().length === 0) {
        return "last_name is required";
    }
    if (!body.agreed_to_compensation || !body.agreed_to_pyramid_disclosure ||
        !body.agreed_to_1099_status || !body.agreed_to_tos) {
        return "All four agreement checkboxes must be accepted";
    }
    return null;
}

// --- Main handler ----------------------------------------------------------
serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
        return errorResponse("Method not allowed", 405);
    }

    let body: PartnerSignupBody;
    try {
        body = await req.json();
    } catch {
        return errorResponse("Invalid JSON", 400);
    }

    const validationErr = validate(body);
    if (validationErr) return errorResponse(validationErr, 400);

    // Service-role client — bypasses RLS
    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } },
    );

    // ── Step 1: create the auth user ───────────────────────────────────────
    const fullName = `${body.first_name.trim()} ${body.last_name.trim()}`;
    // If no email provided, synthesize one from phone (Supabase Auth requires email/phone).
    // Format: phone+digits@lymxpower.local — never delivered to, used as account id only.
    const emailForAuth = body.owner_email
        ? body.owner_email
        : `phone${(body.phone || '').replace(/\D/g, '')}@lymxpower.local`;
    const { data: userData, error: userErr } = await supabase.auth.admin
        .createUser({
            email: emailForAuth,
            password: body.owner_password,
            phone: body.phone || undefined,
            email_confirm: true,
            user_metadata: {
                role: "partner",
                full_name: fullName,
                first_name: body.first_name.trim(),
                last_name: body.last_name.trim(),
                signup_country_code: body.country_code || 'US',
            },
        });

    if (userErr || !userData.user) {
        return errorResponse(
            `Auth creation failed: ${userErr?.message ?? "unknown error"}`,
            400,
        );
    }
    const userId = userData.user.id;

    // ── Step 2: resolve sponsor_partner_id ─────────────────────────────────
    // Accepts EITHER a UUID OR a "P-NNNNNN" code (Kenny 2026-05-14 bug fix:
    // the form sends P-NNNNNN, so we lookup by partner_code, then fall back
    // to UUID). Migration 024 added partner_code + the unique index.
    //
    // FALLBACK: if no sponsor provided (or lookup failed), assign to the
    // LAUNCH SPONSOR (Kenny). Per Kenny 2026-05-14: "if user signs up from
    // website without any invites, all should assign under me".
    const LAUNCH_SPONSOR_PARTNER_ID = "6c77dcf1-d230-4fef-b6e6-2604785ba1ee"; // Kenny (founding 25 rank 1, P-000001)
    let sponsorPartnerId: string | null = null;
    if (body.sponsor_partner_id) {
        const sid = body.sponsor_partner_id.trim();
        const isCode = /^P-\d{6}$/i.test(sid);
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid);
        let lookupBy = "";
        let lookupVal = "";
        if (isCode) { lookupBy = "partner_code"; lookupVal = sid.toUpperCase(); }
        else if (isUuid) { lookupBy = "id"; lookupVal = sid; }
        if (lookupBy) {
            const { data: sp, error: spErr } = await supabase
                .from("partners")
                .select("id, partner_code, display_name")
                .eq(lookupBy, lookupVal)
                .maybeSingle();
            if (spErr) {
                console.error("Sponsor lookup error:", spErr);
            } else if (sp) {
                sponsorPartnerId = sp.id;
                console.log(`Sponsor matched: ${sp.partner_code || sp.id} (${sp.display_name || 'unnamed'})`);
            } else {
                console.warn(`Sponsor "${sid}" not found by ${lookupBy}; signup proceeding without sponsor.`);
            }
        } else {
            console.warn(`Sponsor "${sid}" is not a valid UUID or P-NNNNNN code; falling back to launch sponsor.`);
        }
    }
    // Fallback: anyone without a valid sponsor goes under the launch sponsor (Kenny).
    if (!sponsorPartnerId) {
        sponsorPartnerId = LAUNCH_SPONSOR_PARTNER_ID;
        console.log(`No sponsor matched — assigning to launch sponsor ${LAUNCH_SPONSOR_PARTNER_ID}`);
    }

    // ── Step 3: insert the partners row ────────────────────────────────────
    // Compose contact details. partners.contact_phone allows null.
    const contactPhone = body.phone && body.phone.trim() ? body.phone.trim() : null;

    const { data: partnerData, error: partnerErr } = await supabase
        .from("partners")
        .insert({
            user_id: userId,
            legal_name: fullName,
            display_name: body.first_name.trim(),
            contact_email: body.owner_email || null,
            contact_phone: contactPhone,
            country_code: body.country_code || 'US',
            // verified_at left NULL — admin must verify before commission payouts.
            sponsor_partner_id: sponsorPartnerId,
            // Founding 25 status earned via 5 Direct activations — NOT auto-set on signup.
            is_founding_25: false,
            founding_25_rank: null,
            // Sign-up fee is waived during the launch window.
            signup_fee_paid: false,
            signup_fee_waived: true,
            monthly_fee_status: "waived",
        })
        .select("id, sponsor_partner_id, is_founding_25, founding_25_rank")
        .single();

    if (partnerErr || !partnerData) {
        // Roll back the auth user since we can't proceed without a partner row
        try {
            await supabase.auth.admin.deleteUser(userId);
        } catch (e) {
            console.error("Rollback deleteUser failed:", e);
        }
        return errorResponse(
            `Partner row creation failed: ${partnerErr?.message ?? "unknown error"}`,
            500,
        );
    }

    // ── Step 5: Auto-provision BOTH company emails (best-effort, non-blocking) ──
    // Primary: firstname.lastname@getlymx.com (transactional)
    // Secondary: firstname.lastname@lymxpower.com (marketing)
    const provisioning = { primary: null, secondary: null };
    const SUPA = Deno.env.get("SUPABASE_URL");
    const internalAuth = "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    try {
        const r1 = await fetch(SUPA + "/functions/v1/partner-provision-email", {
            method: "POST",
            headers: { "Authorization": internalAuth, "Content-Type": "application/json" },
            body: JSON.stringify({ partner_id: partnerData.id }),
        });
        provisioning.primary = await r1.json().catch(() => ({ ok: r1.ok }));
    } catch (e) {
        provisioning.primary = { error: e.message };
    }

    try {
        const r2 = await fetch(SUPA + "/functions/v1/provision-marketing-email", {
            method: "POST",
            headers: { "Authorization": internalAuth, "Content-Type": "application/json" },
            body: JSON.stringify({ partner_id: partnerData.id }),
        });
        provisioning.secondary = await r2.json().catch(() => ({ ok: r2.ok }));
    } catch (e) {
        provisioning.secondary = { error: e.message };
    }

    // ── Step 6: Grant marketing staff role (so they can access invite tools) ──
    try {
        await supabase.from("staff_roles").upsert({
            user_id: userId,
            role: "marketing",
            notes: "Auto-granted on partner signup",
        }, { onConflict: "user_id" });
    } catch (e) {
        console.warn("staff_roles upsert failed (non-fatal):", e.message);
    }

    // ── Step 6b: Referral 100+100 — if sponsored, credit BOTH partners ──
    let referralResult = null;
    if (sponsorPartnerId) {
        try {
            const { data: sponsorRow } = await supabase
                .from("partners")
                .select("user_id")
                .eq("id", sponsorPartnerId)
                .maybeSingle();
            if (sponsorRow && sponsorRow.user_id && sponsorRow.user_id !== userId) {
                const { data: refResult, error: refErr } = await supabase.rpc("credit_referral_pair", {
                    p_inviter_id: sponsorRow.user_id,
                    p_invitee_id: userId,
                    p_invite_method: "partner_link",
                    p_invite_template: "partner",
                    p_landing_url: "https://getlymx.com/partner-signup.html",
                    p_user_agent: "partner-signup-fn",
                });
                if (refErr) console.warn("credit_referral_pair failed:", refErr.message);
                else referralResult = refResult;
            }
        } catch (e) { console.warn("Referral pair credit error:", e.message); }
    }

    // ── Step 7: Welcome bonus — new-partner promo (default 500 LYMX) ──
    let partnerBonus = null;
    try {
        const { data: promoAmt } = await supabase.rpc("get_active_promo_amount", { p_key: "new_partner_signup_bonus" });
        const amt = Number(promoAmt) || 0;
        if (amt > 0) {
            const { data: bonusRow, error: bonusErr } = await supabase
                .from("lymx_issuances")
                .insert({
                    recipient_user_id: userId,
                    business_id: null,
                    amount_lymx: amt,
                    reason: "promo",
                    lymx_cost_cents: amt,
                    business_cost_cents: 0,
                    transaction_method: "signup",
                    verified: true,
                    idempotency_key: "new_partner_bonus_" + partnerData.id,
                    user_agent: "partner-signup-fn",
                })
                .select()
                .single();
            if (!bonusErr) partnerBonus = { issuance_id: bonusRow.id, amount_lymx: amt };
        }
    } catch (e) {
        console.warn("new-partner bonus error:", e.message);
    }

    return jsonResponse(
        {
            user_id: userId,
            partner_id: partnerData.id,
            sponsor_partner_id: partnerData.sponsor_partner_id,
            is_founding_25: partnerData.is_founding_25,
            founding_25_rank: partnerData.founding_25_rank,
            email_provisioning: provisioning,
            partner_bonus: partnerBonus,
            referral: referralResult,
        },
        201,
    );
});
