// =============================================================================
// LYMX Power — create-checkout-session
// =============================================================================
// POST /functions/v1/create-checkout-session
//
// Creates a Stripe Checkout Session for a Business to pay LYMX:
//   • mode "signup"        → one-time $850 signup fee (STRIPE_PRICE_SIGNUP)
//   • mode "subscription"  → $199/mo recurring subscription (STRIPE_PRICE_MONTHLY)
//
// Returns { url } — the frontend redirects the owner to Stripe's hosted page.
// On payment, the stripe-webhook EF flips businesses.signup_fee_paid / activates
// the subscription (Stripe is the source of truth; we never mark paid client-side).
//
// AUTH: caller must be the business owner, or an admin (with business_id).
//
// REQUEST BODY:
//   { mode: "signup" | "subscription",
//     business_id?: string,          // optional; defaults to caller's own biz
//     success_url?: string, cancel_url?: string }
//
// REQUIRED SUPABASE SECRETS:
//   STRIPE_SECRET_KEY      — sk_test_… / sk_live_…
//   STRIPE_PRICE_SIGNUP    — price_… for the $850 one-time fee
//   STRIPE_PRICE_MONTHLY   — price_… for the $199/mo subscription
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const err = (m: string, s = 400) => json({ error: m }, s);

function userFromJwt(authHeader: string | null): string | null {
    if (!authHeader) return null;
    const tok = authHeader.replace(/^Bearer\s+/i, "").trim();
    const parts = tok.split(".");
    if (parts.length !== 3) return null;
    try {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        return payload.sub || null;
    } catch { return null; }
}

// Minimal Stripe REST client (form-encoded). Nested params use bracket keys,
// e.g. "line_items[0][price]".
async function stripe(path: string, body: Record<string, string | number | boolean>, secret: string): Promise<{ ok: boolean; status: number; body: any }> {
    const enc = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString();
    const r = await fetch("https://api.stripe.com/v1" + path, {
        method: "POST",
        headers: { "Authorization": "Bearer " + secret, "Content-Type": "application/x-www-form-urlencoded" },
        body: enc,
    });
    let parsed: any = null;
    try { parsed = await r.json(); } catch (e) { console.warn("[create-checkout-session] parse", e); }
    return { ok: r.ok, status: r.status, body: parsed };
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return err("Method not allowed", 405);

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY");
    const PRICE_SIGNUP = Deno.env.get("STRIPE_PRICE_SIGNUP");
    const PRICE_MONTHLY = Deno.env.get("STRIPE_PRICE_MONTHLY");
    if (!SB_URL || !SB_KEY) return err("Server config missing", 500);
    if (!STRIPE_KEY) return err("STRIPE_SECRET_KEY not configured", 500);

    const supabase = createClient(SB_URL, SB_KEY);

    const userId = userFromJwt(req.headers.get("Authorization"));
    if (!userId) return err("Unauthorized", 401);

    let reqBody: { mode?: string; business_id?: string; success_url?: string; cancel_url?: string } = {};
    try { reqBody = await req.json(); } catch (e) { console.warn("[create-checkout-session] body", e); }

    const mode = reqBody.mode === "subscription" ? "subscription" : reqBody.mode === "signup" ? "signup" : null;
    if (!mode) return err("mode must be 'signup' or 'subscription'");
    const price = mode === "signup" ? PRICE_SIGNUP : PRICE_MONTHLY;
    if (!price) return err((mode === "signup" ? "STRIPE_PRICE_SIGNUP" : "STRIPE_PRICE_MONTHLY") + " not configured", 500);

    // Resolve the business — explicit id (admin) or the caller's own business.
    let biz: any = null;
    if (reqBody.business_id) {
        // am_i_admin() must run with the CALLER's JWT (auth.uid()), not the
        // service-role client — otherwise it always returns false and admins
        // can't act on a business by id.
        const userClient = createClient(SB_URL, SB_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
        const { data: isAdmin } = await userClient.rpc("am_i_admin");
        const { data: byId } = await supabase
            .from("businesses")
            .select("id, owner_user_id, display_name, contact_email")
            .eq("id", reqBody.business_id).maybeSingle();
        if (!byId) return err("Business not found", 404);
        if (byId.owner_user_id !== userId && !isAdmin) return err("Not the owner", 403);
        biz = byId;
    } else {
        // limit(1), not maybeSingle() — an owner can have >1 business, and
        // maybeSingle() errors on multiple rows (would 404 a real owner).
        const { data: rows } = await supabase
            .from("businesses")
            .select("id, owner_user_id, display_name, contact_email")
            .eq("owner_user_id", userId).order("created_at", { ascending: true }).limit(1);
        if (!rows || !rows.length) return err("No business found for this account", 404);
        biz = rows[0];
    }

    const origin = "https://getlymx.com";
    const success_url = reqBody.success_url || (origin + "/biz-dashboard.html?payment=success");
    const cancel_url = reqBody.cancel_url || (origin + "/biz-dashboard.html?payment=cancelled");

    // Build the Checkout Session.
    const params: Record<string, string | number | boolean> = {
        "mode": mode === "signup" ? "payment" : "subscription",
        "line_items[0][price]": price,
        "line_items[0][quantity]": 1,
        "success_url": success_url,
        "cancel_url": cancel_url,
        "client_reference_id": biz.id,
        "metadata[business_id]": biz.id,
        "metadata[purpose]": mode,
    };
    if (biz.contact_email) params["customer_email"] = biz.contact_email;
    // Carry the business id onto the subscription too, so invoice webhooks can map back.
    if (mode === "subscription") params["subscription_data[metadata][business_id]"] = biz.id;

    const r = await stripe("/checkout/sessions", params, STRIPE_KEY);
    if (!r.ok || !r.body?.url) {
        return err("Stripe checkout create failed: " + (r.body?.error?.message || r.status), 502);
    }

    return json({ url: r.body.url, session_id: r.body.id });
});
