// =============================================================================
// LYMX Power — Provision Marketing Email (@lymxpower.com)
// =============================================================================
// POST /functions/v1/provision-marketing-email
//
// Provisions firstname.lastname@lymxpower.com as the partner's MARKETING email
// (separate from their @getlymx.com transactional email). Marketing emails
// they SEND (to recruit Businesses/Customers) come from lymxpower.com to keep
// marketing-vs-transactional deliverability separated.
//
// REQUEST BODY:
//   { "partner_id": "uuid" }
//
// AUTH: service_role only (called from partner-signup).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const errorResponse = (msg, status = 400) => json({ error: msg }, status);

function genLocalPart(legalName) {
    if (!legalName) return null;
    const lower = legalName.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const parts = lower.split(/\s+/).filter(p => p.length);
    if (!parts.length) return null;
    if (parts.length === 1) return parts[0].replace(/[^a-z0-9]/g, "");
    const first = parts[0].replace(/[^a-z0-9]/g, "");
    const last  = parts[parts.length - 1].replace(/[^a-z0-9]/g, "");
    return (first + "." + last).replace(/\.+/g, ".");
}

// 2026-05-20 #8ae35834 — same role-decode helper as partner-provision-email.
function getJwtRole(jwt) {
    try {
        const parts = jwt.split(".");
        if (parts.length !== 3) return null;
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        return payload.role || null;
    } catch { return null; }
}

// 2026-05-21 — extract JWT sub (user_id) for admin-staff auth path.
function getJwtSub(jwt) {
    try {
        const parts = jwt.split(".");
        if (parts.length !== 3) return null;
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        return payload.sub || null;
    } catch { return null; }
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return errorResponse("Method not allowed", 405);

    // 2026-05-20 #8ae35834 — service-role only. Previously this EF accepted
    // any anonymous caller; an attacker could spam partner-email provisioning
    // for any partner_id they guessed. Now mirrors partner-provision-email auth.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return errorResponse("Missing Authorization header", 401);
    const token = authHeader.replace(/^Bearer\s+/i, "");
    // 2026-05-21 #d516e0bf v2 (root-cause widen) - accept THREE auth modes:
    //   1. Legacy JWT-format service-role token (role claim = "service_role")
    //   2. New sb_secret_* opaque format (direct match against SUPABASE_SERVICE_ROLE_KEY)
    //   3. Admin staff JWT (user_id in staff_roles with role in admin/tech/support).
    //      Pre-fix: admin-partners.html "Resend welcome" button always 403'd because
    //      the admin JWT is neither service_role nor matches the secret. Now any
    //      admin can re-trigger provisioning from the dashboard UI, which is what
    //      "Resend welcome" was designed for.
    const _serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const _isLegacyJwt = getJwtRole(token) === "service_role";
    const _isNewSecret = !!token && token === _serviceKey;
    let _isAdminStaff = false;
    if (!_isLegacyJwt && !_isNewSecret) {
        const _sub = getJwtSub(token);
        if (_sub) {
            try {
                const _adminClient = createClient(
                    Deno.env.get("SUPABASE_URL"),
                    _serviceKey,
                    { auth: { persistSession: false } }
                );
                const { data: _staffRow } = await _adminClient
                    .from("staff_roles")
                    .select("role")
                    .eq("user_id", _sub)
                    .maybeSingle();
                _isAdminStaff = !!_staffRow && ["admin","tech","support"].includes(_staffRow.role);
            } catch (e) { console.warn("[provision-marketing-email] staff_roles lookup", e); }
        }
    }
    if (!_isLegacyJwt && !_isNewSecret && !_isAdminStaff) {
        return errorResponse("Forbidden: provision-marketing-email requires service-role or admin staff JWT", 403);
    }

    let body;
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON", 400); }
    const { partner_id } = body || {};
    if (!partner_id) return errorResponse("Missing partner_id", 400);

    const supabase = createClient(
        Deno.env.get("SUPABASE_URL"),
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
        { auth: { persistSession: false } }
    );

    // STEP 1: Load partner
    const { data: partner, error: pErr } = await supabase
        .from("partners")
        .select("id, legal_name, display_name, contact_email")
        .eq("id", partner_id)
        .maybeSingle();
    if (pErr || !partner) return errorResponse("Partner not found", 404);

    // STEP 2: Load partner_emails row (must exist — primary was provisioned first)
    const { data: pEmail } = await supabase
        .from("partner_emails")
        .select("id, secondary_status, secondary_full_email")
        .eq("partner_id", partner.id)
        .maybeSingle();

    if (pEmail && pEmail.secondary_status === "active") {
        return json({
            success: true,
            note: "Already provisioned",
            partner_email_id: pEmail.id,
            full_email: pEmail.secondary_full_email,
        });
    }

    // STEP 3: Generate local-part (firstname.lastname). Handle collisions.
    let basePart = genLocalPart(partner.legal_name);
    if (!basePart) return errorResponse("Cannot generate local-part from legal_name", 400);

    let localPart = basePart;
    for (let attempt = 1; attempt <= 100; attempt++) {
        const candidate = attempt === 1 ? basePart : (basePart + "." + attempt);
        const { data: exists } = await supabase
            .from("partner_emails")
            .select("id")
            .eq("secondary_local_part", candidate)
            .maybeSingle();
        if (!exists) { localPart = candidate; break; }
        if (attempt === 100) return errorResponse("Too many collisions on local-part", 500);
    }

    const fullEmail = localPart + "@lymxpower.com";

    // STEP 4: Mark provisioning
    if (pEmail) {
        await supabase.from("partner_emails").update({
            secondary_local_part: localPart,
            secondary_full_email: fullEmail,
            secondary_status: "provisioning",
        }).eq("id", pEmail.id);
    } else {
        // Insert a fresh row if primary hasn't been provisioned yet
        await supabase.from("partner_emails").insert({
            partner_id: partner.id,
            secondary_local_part: localPart,
            secondary_full_email: fullEmail,
            secondary_status: "provisioning",
            forward_to: partner.contact_email,
            status: "pending",
        });
    }

    // STEP 5: Create Cloudflare email-routing rule on lymxpower.com zone
    const CF_TOKEN = Deno.env.get("CF_API_TOKEN_LYMXPOWER") || Deno.env.get("CF_API_TOKEN_LYMX");
    const CF_ZONE  = Deno.env.get("CF_ZONE_ID_LYMXPOWER");

    if (!CF_TOKEN || !CF_ZONE) {
        await supabase.from("partner_emails").update({
            secondary_status: "failed",
            secondary_last_error: "Missing CF_API_TOKEN_LYMXPOWER or CF_ZONE_ID_LYMXPOWER env var",
        }).eq("partner_id", partner.id);
        return errorResponse("Cloudflare config missing for lymxpower.com — set CF_ZONE_ID_LYMXPOWER + CF_API_TOKEN_LYMXPOWER in Edge Function secrets", 500);
    }

    const cfRes = await fetch("https://api.cloudflare.com/client/v4/zones/" + CF_ZONE + "/email/routing/rules", {
        method: "POST",
        headers: { "Authorization": "Bearer " + CF_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({
            actions: [{ type: "forward", value: [partner.contact_email] }],
            matchers: [{ type: "literal", field: "to", value: fullEmail }],
            enabled: true,
            name: "partner_" + partner.id.slice(0, 8) + "_marketing",
            priority: 50,
        }),
    });

    const cfJson = await cfRes.json().catch(() => ({}));
    if (!cfRes.ok || !cfJson.success) {
        const errMsg = "Cloudflare API: " + (cfJson.errors ? JSON.stringify(cfJson.errors).slice(0, 200) : cfRes.status);
        await supabase.from("partner_emails").update({
            secondary_status: "failed",
            secondary_last_error: errMsg,
        }).eq("partner_id", partner.id);
        return errorResponse(errMsg, 500);
    }

    const routeId = cfJson.result.id;

    // STEP 6: Mark active
    await supabase.from("partner_emails").update({
        secondary_cloudflare_route_id: routeId,
        secondary_synced_at: new Date().toISOString(),
        secondary_status: "active",
        secondary_provisioned_at: new Date().toISOString(),
        secondary_last_error: null,
    }).eq("partner_id", partner.id);

    return json({
        success: true,
        partner_email_id: pEmail?.id || partner.id,
        full_email: fullEmail,
        cloudflare_route_id: routeId,
        domain: "lymxpower.com",
    });
});
