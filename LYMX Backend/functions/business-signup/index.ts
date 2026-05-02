// =============================================================================
// LYMX Power — Business Sign-up Endpoint
// =============================================================================
// POST /functions/v1/business-signup
//
// Creates a new business + primary location + subscription (3-month trial).
// Optionally attributes the sign-up to a partner (referral code).
//
// REQUEST BODY (JSON):
// {
//   "owner_email": "owner@example.com",
//   "owner_password": "min10chars",
//   "legal_name": "Brew & Bean LLC",
//   "display_name": "Brew & Bean",
//   "category": "cafe",
//   "contact_email": "hello@brewandbean.com",
//   "contact_phone": "+17025551234",
//   "location": {
//     "name": "Main Street",
//     "street": "123 Main St",
//     "city": "Las Vegas",
//     "state": "NV",
//     "zip": "89101"
//   },
//   "partner_referral_code": "PARTNER-XYZ"   // optional — partner_id in our system
// }
//
// RESPONSE (200):
// {
//   "user_id": "uuid",
//   "business_id": "uuid",
//   "location_id": "uuid",
//   "subscription_id": "uuid"
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

interface SignupBody {
    owner_email: string;
    owner_password: string;
    legal_name: string;
    display_name: string;
    category?: string;
    contact_email: string;
    contact_phone?: string;
    location: {
        name: string;
        street?: string;
        city?: string;
        state?: string;
        zip?: string;
    };
    partner_referral_code?: string;
}

serve(async (req) => {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
        return errorResponse("Method not allowed", 405);
    }

    // Parse + validate body
    let body: SignupBody;
    try {
        body = await req.json();
    } catch {
        return errorResponse("Invalid JSON", 400);
    }

    const required = [
        "owner_email",
        "owner_password",
        "legal_name",
        "display_name",
        "contact_email",
        "location",
    ];
    for (const k of required) {
        if (!(k in body) || (body as Record<string, unknown>)[k] == null) {
            return errorResponse(`Missing required field: ${k}`, 400);
        }
    }
    if (!body.location.name) {
        return errorResponse("location.name is required", 400);
    }

    // Service-role client — bypasses RLS
    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } }
    );

    // Step 1: create the auth user
    const { data: userData, error: userErr } = await supabase.auth.admin
        .createUser({
            email: body.owner_email,
            password: body.owner_password,
            email_confirm: true, // auto-confirm so the owner can sign in immediately
            user_metadata: { role: "business_owner" },
        });

    if (userErr || !userData.user) {
        return errorResponse(`Auth creation failed: ${userErr?.message}`, 400);
    }
    const userId = userData.user.id;

    // Step 2: resolve partner_referral_code → partner_id (if provided)
    let signedUpByPartnerId: string | null = null;
    if (body.partner_referral_code) {
        // Convention: referral code is the partner's UUID (or a short slug;
        // for Phase 1 we accept the UUID directly).
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
        // If no match: silently ignore. Don't block signup on a bad code.
    }

    // Step 3: create the business
    const { data: biz, error: bizErr } = await supabase
        .from("businesses")
        .insert({
            legal_name: body.legal_name,
            display_name: body.display_name,
            category: body.category ?? null,
            contact_email: body.contact_email,
            contact_phone: body.contact_phone ?? null,
            owner_user_id: userId,
            signed_up_by_partner_id: signedUpByPartnerId,
        })
        .select("id")
        .single();

    if (bizErr || !biz) {
        // Rollback: delete the auth user we just created
        await supabase.auth.admin.deleteUser(userId);
        return errorResponse(`Business creation failed: ${bizErr?.message}`, 500);
    }

    // Step 4: create the primary location
    const { data: loc, error: locErr } = await supabase
        .from("business_locations")
        .insert({
            business_id: biz.id,
            name: body.location.name,
            street: body.location.street ?? null,
            city: body.location.city ?? null,
            state: body.location.state ?? null,
            zip: body.location.zip ?? null,
            is_primary: true,
        })
        .select("id")
        .single();

    if (locErr || !loc) {
        // Rollback both
        await supabase.from("businesses").delete().eq("id", biz.id);
        await supabase.auth.admin.deleteUser(userId);
        return errorResponse(`Location creation failed: ${locErr?.message}`, 500);
    }

    // Step 5: create the subscription (trialing, 3 months free)
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
        // Don't roll back — business + location are valid; subscription can be retried
        console.error("Subscription creation failed:", subErr);
    }

    // Step 6: if a partner referred them, log the $500 sign-up bonus
    if (signedUpByPartnerId) {
        const { error: commErr } = await supabase
            .from("partner_commissions")
            .insert({
                partner_id: signedUpByPartnerId,
                source_business_id: biz.id,
                type: "signup_bonus",
                generation: 1,
                amount: 500, // $500 — Founding 25 partners get 1.5x ($750), handled in a later migration
            });
        if (commErr) {
            console.error("Partner commission log failed:", commErr);
        }
    }

    return jsonResponse({
        user_id: userId,
        business_id: biz.id,
        location_id: loc.id,
        subscription_id: sub?.id ?? null,
    }, 201);
});
