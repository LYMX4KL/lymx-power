// =============================================================================
// LYMX Power — Stripe Connect Onboarding
// =============================================================================
// POST /functions/v1/stripe-connect-onboarding
//
// Creates a Stripe Connect Express account for a Business (or returns the
// existing one) and generates an AccountLink the owner can use to complete
// onboarding (KYC, bank, identity).
//
// REQUEST BODY (called by signed-in Business owner from biz-payouts.html):
//   { business_id?: string }      // optional; defaults to the caller's own biz
//
// RESPONSE (200):
//   { url: "https://connect.stripe.com/express/...", account_id: "acct_..." }
//
// AUTH: caller must be the owner of the business, OR an admin.
//
// REQUIRED SUPABASE SECRETS:
//   STRIPE_SECRET_KEY     — your Stripe live or test secret (sk_live_... / sk_test_...)
//   STRIPE_CONNECT_RETURN_URL  — e.g. https://getlymx.com/biz-payouts.html?status=ok
//   STRIPE_CONNECT_REFRESH_URL — e.g. https://getlymx.com/biz-payouts.html?status=refresh
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

// Minimal Stripe REST client — we avoid the npm package because of Deno
async function stripe(path: string, opts: { method: string; body?: Record<string, string | number | boolean> }, secret: string): Promise<{ ok: boolean; status: number; body: any }> {
    const url = "https://api.stripe.com/v1" + path;
    const body = opts.body
        ? new URLSearchParams(Object.entries(opts.body).map(([k, v]) => [k, String(v)])).toString()
        : undefined;
    const r = await fetch(url, {
        method: opts.method,
        headers: {
            "Authorization": "Bearer " + secret,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
    });
    let parsed: any = null;
    try { parsed = await r.json(); } catch (e) { console.warn('[index.ts:L61] silent error', e); }
    return { ok: r.ok, status: r.status, body: parsed };
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return err("Method not allowed", 405);

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY");
    const RET = Deno.env.get("STRIPE_CONNECT_RETURN_URL") || "https://getlymx.com/biz-payouts.html?status=ok";
    const REF = Deno.env.get("STRIPE_CONNECT_REFRESH_URL") || "https://getlymx.com/biz-payouts.html?status=refresh";
    if (!SB_URL || !SB_KEY) return err("Server config missing", 500);
    if (!STRIPE_KEY) return err("STRIPE_SECRET_KEY not configured", 500);

    const supabase = createClient(SB_URL, SB_KEY);

    const userId = userFromJwt(req.headers.get("Authorization"));
    if (!userId) return err("Unauthorized", 401);

    let body: { business_id?: string } = {};
    try { body = await req.json(); } catch (e) { console.warn('[index.ts:L83] silent error', e); }

    // Find the business — either explicit business_id (admin path) or owner_user_id
    let biz: any = null;
    if (body.business_id) {
        const { data: isAdmin } = await supabase.rpc("am_i_admin");
        const { data: byId } = await supabase
            .from("businesses")
            .select("id, owner_user_id, display_name, contact_email, stripe_connect_account_id")
            .eq("id", body.business_id).maybeSingle();
        if (!byId) return err("Business not found", 404);
        if (byId.owner_user_id !== userId && !isAdmin) return err("Not the owner", 403);
        biz = byId;
    } else {
        const { data: byOwner } = await supabase
            .from("businesses")
            .select("id, owner_user_id, display_name, contact_email, stripe_connect_account_id")
            .eq("owner_user_id", userId)
            .order("created_at", { ascending: false })
            .limit(1).maybeSingle();
        if (!byOwner) return err("You don't own a business yet — sign up at /biz-signup.html first", 404);
        biz = byOwner;
    }

    // Create the Connect account if one doesn't exist
    let accountId = biz.stripe_connect_account_id;
    if (!accountId) {
        const created = await stripe("/accounts", {
            method: "POST",
            body: {
                "type": "express",
                "country": "US",
                "email": biz.contact_email || "",
                "capabilities[card_payments][requested]": true,
                "capabilities[transfers][requested]": true,
                "business_type": "company",
                "metadata[lymx_business_id]": biz.id,
                "metadata[lymx_display_name]": biz.display_name || "",
            },
        }, STRIPE_KEY);
        if (!created.ok) return err("Stripe account create failed: " + (created.body?.error?.message || created.status), 502);
        accountId = created.body.id;

        // Save it
        await supabase
            .from("businesses")
            .update({ stripe_connect_account_id: accountId, stripe_last_synced_at: new Date().toISOString() })
            .eq("id", biz.id);
    }

    // Create an AccountLink so the owner can complete onboarding
    const link = await stripe("/account_links", {
        method: "POST",
        body: {
            "account": accountId,
            "return_url": RET,
            "refresh_url": REF,
            "type": "account_onboarding",
        },
    }, STRIPE_KEY);
    if (!link.ok) return err("Stripe AccountLink failed: " + (link.body?.error?.message || link.status), 502);

    return json({ url: link.body.url, account_id: accountId });
});
