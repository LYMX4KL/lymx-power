// =============================================================================
// LYMX Power — Business Sign-up Endpoint
// =============================================================================
// POST /functions/v1/business-signup
//
// Creates a new business + (optional) primary location + subscription
// (3-month trial). Optionally attributes the sign-up to a partner.
//
// REQUEST BODY (discriminated union — `kind` selects the shape):
//
//   ── Mode 1: Storefront ────────────────────────────────────────────────
//   {
//     "kind": "storefront",
//     "owner_email": "owner@example.com",
//     "owner_password": "min10chars",
//     "legal_name": "Brew & Bean LLC",
//     "display_name": "Brew & Bean",
//     "category": "cafe",
//     "contact_email": "hello@brewandbean.com",
//     "contact_phone": "+17025551234",
//     "issuance_rate": 5,            // optional, defaults to schema default
//     "location": {                  // required for storefront
//       "name": "Main Street",
//       "street": "123 Main St",
//       "city": "Las Vegas", "state": "NV", "zip": "89101"
//     },
//     "partner_referral_code": "PARTNER-XYZ"   // optional
//   }
//
//   ── Mode 3: Self-employed professional ────────────────────────────────
//   {
//     "kind": "self_employed",
//     "owner_email": "...",  "owner_password": "...",
//     "legal_name": "Jane Doe Consulting",
//     "display_name": "Jane Doe",
//     "category": "consulting",
//     "contact_email": "...",  "contact_phone": "...",
//     "service_area": "Clark County, NV",   // optional, free text
//     "services": [                          // required, >= 1 row
//       { "service_name": "60-min consult", "price_usd": 150, "lymx_per_booking": 1500 },
//       { "service_name": "Project audit",  "price_usd": 500, "lymx_per_booking": 5000 }
//     ],
//     "partner_referral_code": "PARTNER-XYZ"   // optional
//   }
//
//   ── Legacy (no `kind`) ────────────────────────────────────────────────
//   Treated as Mode 1 storefront. Backwards-compatible with existing callers.
//
// RESPONSE (201):
// {
//   "user_id": "uuid",
//   "business_id": "uuid",
//   "location_id": "uuid" | null,
//   "subscription_id": "uuid",
//   "service_ids": ["uuid", ...]   // only for self_employed
// }
//
// IMPORTANT: This function uses service_role to bypass RLS, because we need
// to create rows BEFORE the user is signed in.
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

// --- Body shapes -----------------------------------------------------------
interface CommonFields {
    owner_email: string;
    owner_password: string;
    legal_name: string;
    display_name: string;
    category?: string;
    contact_email: string;
    contact_phone?: string;
    partner_referral_code?: string;
}

interface StorefrontBody extends CommonFields {
    kind?: "storefront";
    issuance_rate?: number;
    location: {
        name: string;
        street?: string;
        city?: string;
        state?: string;
        zip?: string;
    };
}

interface SelfEmployedBody extends CommonFields {
    kind: "self_employed";
    service_area?: string;
    services: Array<{
        service_name: string;
        description?: string;
        price_usd?: number;
        lymx_per_booking: number;
        sort_order?: number;
    }>;
}

type SignupBody = StorefrontBody | SelfEmployedBody;

// --- Validators ------------------------------------------------------------
const COMMON_REQUIRED = [
    "owner_email",
    "owner_password",
    "legal_name",
    "display_name",
    "contact_email",
] as const;

function validateCommon(body: SignupBody): string | null {
    for (const k of COMMON_REQUIRED) {
        const v = (body as Record<string, unknown>)[k];
        if (v == null || v === "") return `Missing required field: ${k}`;
    }
    if (typeof body.owner_password === "string" && body.owner_password.length < 10) {
        return "owner_password must be at least 10 characters";
    }
    return null;
}

function validateStorefront(body: StorefrontBody): string | null {
    if (!body.location) return "Missing required field: location";
    if (!body.location.name) return "location.name is required";
    if (body.issuance_rate != null && body.issuance_rate < 0) {
        return "issuance_rate must be non-negative";
    }
    return null;
}

function validateSelfEmployed(body: SelfEmployedBody): string | null {
    if (!Array.isArray(body.services) || body.services.length === 0) {
        return "self_employed signup requires services: [...] with at least 1 row";
    }
    for (let i = 0; i < body.services.length; i++) {
        const s = body.services[i];
        if (!s.service_name) return `services[${i}].service_name is required`;
        if (typeof s.lymx_per_booking !== "number" || s.lymx_per_booking < 0) {
            return `services[${i}].lymx_per_booking must be a non-negative number`;
        }
        if (s.price_usd != null && s.price_usd < 0) {
            return `services[${i}].price_usd must be non-negative`;
        }
    }
    return null;
}

// --- Main handler ----------------------------------------------------------
serve(async (req) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
        return errorResponse("Method not allowed", 405);
    }

    let body: SignupBody;
    try {
        body = await req.json();
    } catch {
        return errorResponse("Invalid JSON", 400);
    }

    // Default kind = 'storefront' for backwards compatibility
    const kind = body.kind ?? "storefront";
    if (kind !== "storefront" && kind !== "self_employed") {
        return errorResponse(
            `Unsupported kind: ${kind}. Use 'storefront' or 'self_employed'.`,
            400,
        );
    }

    const commonErr = validateCommon(body);
    if (commonErr) return errorResponse(commonErr, 400);

    const modeErr = kind === "storefront"
        ? validateStorefront(body as StorefrontBody)
        : validateSelfEmployed(body as SelfEmployedBody);
    if (modeErr) return errorResponse(modeErr, 400);

    // Service-role client — bypasses RLS
    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } }
    );

    // ── Step 1: create the auth user ───────────────────────────────────────
    const { data: userData, error: userErr } = await supabase.auth.admin
        .createUser({
            email: body.owner_email,
            password: body.owner_password,
            email_confirm: true,
            user_metadata: { role: "business_owner", business_kind: kind },
        });

    if (userErr || !userData.user) {
        return errorResponse(`Auth creation failed: ${userErr?.message}`, 400);
    }
    const userId = userData.user.id;

    // ── Step 2: resolve partner_referral_code → partner_id ────────────────
    let signedUpByPartnerId: string | null = null;
    if (body.partner_referral_code) {
        const { data: p, error: pErr } = await supabase
            .from("partners")
            .select("id")
            .eq("id", body.partner_referral_code)
            .maybeSingle();
        if (pErr) {
            console.error("Partner lookup error:", pErr);
        } else if (p) {
            signedUpByPartnerId = p.id;
        }
    }

    // ── Step 3: create the business ────────────────────────────────────────
    const bizInsert: Record<string, unknown> = {
        legal_name: body.legal_name,
        display_name: body.display_name,
        category: body.category ?? null,
        contact_email: body.contact_email,
        contact_phone: body.contact_phone ?? null,
        owner_user_id: userId,
        signed_up_by_partner_id: signedUpByPartnerId,
        business_kind: kind,
    };
    if (kind === "storefront" && (body as StorefrontBody).issuance_rate != null) {
        bizInsert.issuance_rate = (body as StorefrontBody).issuance_rate;
    }

    const { data: biz, error: bizErr } = await supabase
        .from("businesses")
        .insert(bizInsert)
        .select("id")
        .single();

    if (bizErr || !biz) {
        await supabase.auth.admin.deleteUser(userId);
        return errorResponse(`Business creation failed: ${bizErr?.message}`, 500);
    }

    // ── Step 4: create the primary location (storefront only) ──────────────
    let locationId: string | null = null;
    if (kind === "storefront") {
        const loc = (body as StorefrontBody).location;
        const { data: locRow, error: locErr } = await supabase
            .from("business_locations")
            .insert({
                business_id: biz.id,
                name: loc.name,
                street: loc.street ?? null,
                city: loc.city ?? null,
                state: loc.state ?? null,
                zip: loc.zip ?? null,
                is_primary: true,
            })
            .select("id")
            .single();

        if (locErr || !locRow) {
            await supabase.from("businesses").delete().eq("id", biz.id);
            await supabase.auth.admin.deleteUser(userId);
            return errorResponse(`Location creation failed: ${locErr?.message}`, 500);
        }
        locationId = locRow.id;
    }

    // ── Step 4b: create custom services (self_employed only) ───────────────
    let serviceIds: string[] = [];
    if (kind === "self_employed") {
        const sb = body as SelfEmployedBody;
        const rows = sb.services.map((s, i) => ({
            business_id: biz.id,
            service_name: s.service_name,
            description: s.description ?? null,
            price_usd: s.price_usd ?? null,
            lymx_per_booking: s.lymx_per_booking,
            sort_order: s.sort_order ?? i,
        }));
        const { data: svcRows, error: svcErr } = await supabase
            .from("business_custom_services")
            .insert(rows)
            .select("id");

        if (svcErr || !svcRows) {
            await supabase.from("businesses").delete().eq("id", biz.id);
            await supabase.auth.admin.deleteUser(userId);
            return errorResponse(
                `Custom services creation failed: ${svcErr?.message}`,
                500,
            );
        }
        serviceIds = svcRows.map((r) => r.id);
    }

    // ── Step 5: create the subscription (3-month trial) ───────────────────
    const trialEnd = new Date();
    trialEnd.setMonth(trialEnd.getMonth() + 3);
    const { data: sub, error: subErr } = await supabase
        .from("business_subscriptions")
        .insert({
            business_id: biz.id,
            plan: "standard",
            status: "trialing",
            monthly_amount: 199,
            trial_ends_at: trialEnd.toISOString(),
            current_period_start: new Date().toISOString(),
            current_period_end: trialEnd.toISOString(),
        })
        .select("id")
        .single();

    if (subErr || !sub) {
        // Don't roll back — biz + (location|services) are valid; sub can be retried
        console.error("Subscription creation failed:", subErr);
    }

    // ── Step 6: log $500 sign-up bonus if a partner referred them ─────────
    if (signedUpByPartnerId) {
        const { error: commErr } = await supabase
            .from("partner_commissions")
            .insert({
                partner_id: signedUpByPartnerId,
                source_business_id: biz.id,
                type: "signup_bonus",
                generation: 1,
                amount: 500,
            });
        if (commErr) {
            console.error("Partner commission log failed:", commErr);
        }
    }

    return jsonResponse({
        user_id: userId,
        business_id: biz.id,
        location_id: locationId,
        subscription_id: sub?.id ?? null,
        service_ids: serviceIds,
        kind,
    }, 201);
});
