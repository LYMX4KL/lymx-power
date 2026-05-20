// =============================================================================
// LYMX Power — Partner Upgrade Endpoint (existing-customer variant)
// =============================================================================
// POST /functions/v1/partner-upgrade
//
// "Apply to become a partner" path for users who are ALREADY signed in as
// a customer (or any non-partner role). Mirrors partner-signup but skips
// auth.users creation (uses the JWT) and keeps the existing customers row
// (additive role — they keep earning LYMX as a shopper).
//
// Why this exists: the partner-signup flow assumes a brand-new user. When a
// signed-in customer hit it, lymx-nav.js was bouncing them to their
// dashboard (see ticket #8ae35834). The proper fix is this dedicated
// upgrade path — no role corruption, no duplicate accounts, no manual
// admin work. Auto-approves; admin can revoke via admin-partners later.
//
// REQUEST BODY:
// {
//   "sponsor_partner_id": "uuid-or-P-NNNNNN-code",  // optional — from ?ref=
//   "phone":              "+17025551234",            // optional, fills partner row
//   "city":               "Las Vegas",               // optional
//   "state":              "NV",                      // optional
//   "agreed_to_compensation":      true,
//   "agreed_to_pyramid_disclosure": true,
//   "agreed_to_1099_status":       true,
//   "agreed_to_tos":               true
// }
//
// AUTH:
//   - User JWT REQUIRED. Anon submissions return 401.
//
// RESPONSE (201):
// {
//   "partner_id":            "uuid",
//   "user_id":               "uuid",       // same as JWT sub
//   "sponsor_partner_id":    "uuid",
//   "provisioning": { primary: {...}, secondary: {...} },
//   "welcome_bonus":         { issuance_id, amount_lymx } | null,
//   "referral":              {...} | null
// }
//
// IDEMPOTENCY: if a partners row already exists for this user_id, returns
// 409 with the existing partner_id. Safe to retry from the client.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
const err = (message: string, status = 400) => json({ error: message }, status);

// Kenny — founding 25 rank 1, P-000001. Used when caller has no sponsor.
const LAUNCH_SPONSOR_PARTNER_ID = "6c77dcf1-d230-4fef-b6e6-2604785ba1ee";

interface UpgradeBody {
    sponsor_partner_id?: string;
    phone?: string;
    city?: string;
    state?: string;
    country_code?: string;
    agreed_to_compensation?: boolean;
    agreed_to_pyramid_disclosure?: boolean;
    agreed_to_1099_status?: boolean;
    agreed_to_tos?: boolean;
}

function validate(b: UpgradeBody): string | null {
    if (!b.agreed_to_compensation || !b.agreed_to_pyramid_disclosure ||
        !b.agreed_to_1099_status || !b.agreed_to_tos) {
        return "All four agreement checkboxes must be accepted";
    }
    return null;
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST")    return err("Method not allowed", 405);

    // 1. Decode JWT — must be a signed-in user
    const authHeader = req.headers.get("authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return err("Authorization header required", 401);

    let userId: string;
    let userEmail: string | null = null;
    try {
        const parts = jwt.split(".");
        if (parts.length !== 3) throw new Error("Bad JWT");
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        userId = payload.sub;
        userEmail = payload.email || null;
        if (!userId) throw new Error("No sub claim");
    } catch (e) {
        return err("Invalid token", 401);
    }

    // 2. Parse body
    let body: UpgradeBody;
    try {
        body = await req.json();
    } catch {
        return err("Invalid JSON", 400);
    }
    const ve = validate(body);
    if (ve) return err(ve, 400);

    // 3. Service-role client
    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } },
    );

    // 4. Already a partner? Return 409 with existing partner_id (idempotency).
    {
        const { data: existing } = await supabase
            .from("partners")
            .select("id, partner_code")
            .eq("user_id", userId)
            .maybeSingle();
        if (existing) {
            return json({
                error: "Already a partner",
                partner_id: existing.id,
                partner_code: existing.partner_code,
            }, 409);
        }
    }

    // 5. Look up the existing customers row for name/phone. Optional — if they
    //    don't have one (orphaned auth user), we still create the partners row
    //    using the JWT email; their customers row can be created later.
    let firstName = "";
    let lastName = "";
    let custPhone: string | null = null;
    {
        const { data: cust } = await supabase
            .from("customers")
            .select("display_name, phone")
            .eq("user_id", userId)
            .maybeSingle();
        if (cust) {
            const parts = String(cust.display_name || "").trim().split(/\s+/).filter(Boolean);
            firstName = parts[0] || "";
            lastName  = parts.slice(1).join(" ") || "";
            custPhone = cust.phone || null;
        }
    }
    // Fall back to user_metadata if customers row is sparse.
    if (!firstName || !lastName) {
        try {
            const { data: u } = await supabase.auth.admin.getUserById(userId);
            const meta = (u?.user?.user_metadata || {}) as Record<string, string>;
            firstName = firstName || meta.first_name || meta.given_name || (meta.full_name || "").split(/\s+/)[0] || "";
            lastName  = lastName  || meta.last_name  || meta.family_name || (meta.full_name || "").split(/\s+/).slice(1).join(" ") || "";
        } catch (e) {
            console.warn("getUserById failed:", e.message);
        }
    }
    if (!firstName) {
        // Last-resort: derive from email local-part
        firstName = (userEmail || "").split("@")[0].split(/[._-]+/)[0] || "Partner";
    }

    // 6. Resolve sponsor (P-NNNNNN code OR UUID, fallback to launch sponsor)
    let sponsorPartnerId: string | null = null;
    if (body.sponsor_partner_id) {
        const sid = body.sponsor_partner_id.trim();
        const isCode = /^P-\d{6}$/i.test(sid);
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid);
        if (isCode || isUuid) {
            const { data: sp } = await supabase
                .from("partners")
                .select("id")
                .eq(isCode ? "partner_code" : "id", isCode ? sid.toUpperCase() : sid)
                .maybeSingle();
            if (sp) sponsorPartnerId = sp.id;
        }
    }
    if (!sponsorPartnerId) sponsorPartnerId = LAUNCH_SPONSOR_PARTNER_ID;

    // 7. INSERT partners row (additive — customers row STAYS, this is critical)
    const fullName = `${firstName} ${lastName}`.trim();
    const phone = (body.phone && body.phone.trim()) || custPhone || null;

    const { data: partnerData, error: partnerErr } = await supabase
        .from("partners")
        .insert({
            user_id: userId,
            legal_name: fullName,
            display_name: firstName,
            contact_email: userEmail,
            contact_phone: phone,
            country_code: body.country_code || "US",
            sponsor_partner_id: sponsorPartnerId,
            is_founding_25: false,
            founding_25_rank: null,
            signup_fee_paid: false,
            signup_fee_waived: true,
            monthly_fee_status: "waived",
        })
        .select("id, partner_code, sponsor_partner_id, is_founding_25, founding_25_rank")
        .single();

    if (partnerErr || !partnerData) {
        return err(`Partner row creation failed: ${partnerErr?.message ?? "unknown"}`, 500);
    }

    // 8. Auto-provision BOTH company emails (best-effort, non-blocking).
    const SUPA = Deno.env.get("SUPABASE_URL");
    const internalAuth = "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const provisioning: { primary: unknown; secondary: unknown } = { primary: null, secondary: null };

    try {
        const r1 = await fetch(SUPA + "/functions/v1/partner-provision-email", {
            method: "POST",
            headers: { "Authorization": internalAuth, "Content-Type": "application/json" },
            body: JSON.stringify({ partner_id: partnerData.id }),
        });
        provisioning.primary = await r1.json().catch(() => ({ ok: r1.ok }));
    } catch (e) { provisioning.primary = { error: (e as Error).message }; }

    try {
        const r2 = await fetch(SUPA + "/functions/v1/provision-marketing-email", {
            method: "POST",
            headers: { "Authorization": internalAuth, "Content-Type": "application/json" },
            body: JSON.stringify({ partner_id: partnerData.id }),
        });
        provisioning.secondary = await r2.json().catch(() => ({ ok: r2.ok }));
    } catch (e) { provisioning.secondary = { error: (e as Error).message }; }

    // 9. Grant marketing staff role (so they can access invite tools)
    try {
        await supabase.from("staff_roles").upsert({
            user_id: userId,
            role: "marketing",
            notes: "Auto-granted on partner upgrade",
        }, { onConflict: "user_id" });
    } catch (e) { console.warn("staff_roles upsert failed (non-fatal):", (e as Error).message); }

    // 10. Referral 100+100 — credit the sponsor + new partner pair
    let referralResult: unknown = null;
    if (sponsorPartnerId && sponsorPartnerId !== LAUNCH_SPONSOR_PARTNER_ID) {
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
                    p_invite_method: "partner_upgrade",
                    p_invite_template: "partner",
                    p_landing_url: "https://getlymx.com/partner-upgrade.html",
                    p_user_agent: "partner-upgrade-fn",
                });
                if (refErr) console.warn("credit_referral_pair failed:", refErr.message);
                else referralResult = refResult;
            }
        } catch (e) { console.warn("Referral pair credit error:", (e as Error).message); }
    }

    // 11. Welcome bonus — new-partner promo (default 500 LYMX)
    let partnerBonus: { issuance_id: string; amount_lymx: number } | null = null;
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
                    user_agent: "partner-upgrade-fn",
                })
                .select()
                .single();
            if (!bonusErr) partnerBonus = { issuance_id: bonusRow.id, amount_lymx: amt };
            else console.warn("welcome bonus failed:", bonusErr.message);
        }
    } catch (e) { console.warn("new-partner bonus error:", (e as Error).message); }

    return json({
        partner_id: partnerData.id,
        partner_code: partnerData.partner_code,
        user_id: userId,
        sponsor_partner_id: partnerData.sponsor_partner_id,
        is_founding_25: partnerData.is_founding_25,
        founding_25_rank: partnerData.founding_25_rank,
        provisioning,
        welcome_bonus: partnerBonus,
        referral: referralResult,
    }, 201);
});
