// =============================================================================
// LYMX Power — Customer Wallet Creation Endpoint
// =============================================================================
// POST /functions/v1/customer-wallet-create
//
// Creates (or returns existing) wallet for the calling customer at a given
// business. Idempotent — calling twice with the same (customer, business)
// returns the existing wallet, not an error.
//
// AUTH: Caller must be a logged-in user. We look up their customer row and
// auto-provision one if missing (e.g. brand-new sign-up).
//
// REQUEST HEADERS:
//   Authorization: Bearer <user_jwt>     // from supabase.auth.signInWithPassword
//
// REQUEST BODY (JSON):
// {
//   "business_id": "uuid",
//   "phone": "+17025551234",      // only used on first call (auto-provision customer row)
//   "display_name": "Maya"        // optional
// }
//
// RESPONSE (200):
// {
//   "wallet_id": "uuid",
//   "customer_id": "uuid",
//   "balance": 0,
//   "lifetime_earned": 0,
//   "created": true | false       // true if just created, false if already existed
// }
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

interface WalletBody {
    business_id: string;
    phone?: string;
    display_name?: string;
}

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
        return errorResponse("Method not allowed", 405);
    }

    // Pull the user's JWT out of the Authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
        return errorResponse("Missing Authorization header", 401);
    }

    // Build a service-role client (bypasses RLS — we'll do auth checks ourselves)
    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } }
    );

    // Verify the JWT and get the user
    const { data: { user }, error: userErr } = await supabase.auth.getUser(
        authHeader.replace("Bearer ", "")
    );
    if (userErr || !user) {
        return errorResponse("Invalid auth token", 401);
    }

    let body: WalletBody;
    try {
        body = await req.json();
    } catch {
        return errorResponse("Invalid JSON", 400);
    }
    if (!body.business_id) {
        return errorResponse("business_id is required", 400);
    }

    // Step 1: ensure the business exists
    const { data: biz } = await supabase
        .from("businesses")
        .select("id, archived_at")
        .eq("id", body.business_id)
        .maybeSingle();
    if (!biz || biz.archived_at) {
        return errorResponse("Business not found", 404);
    }

    // Step 2: find or create the customer row
    let { data: customer } = await supabase
        .from("customers")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle();

    if (!customer) {
        // First-time customer — provision the row
        const phone = body.phone || user.phone || user.email || `user-${user.id}`;
        const { data: newCustomer, error: cErr } = await supabase
            .from("customers")
            .insert({
                user_id: user.id,
                phone,
                email: user.email ?? null,
                display_name: body.display_name ?? null,
            })
            .select("id")
            .single();

        if (cErr || !newCustomer) {
            return errorResponse(
                `Customer provisioning failed: ${cErr?.message}`,
                500
            );
        }
        customer = newCustomer;
    }

    // Step 3: find or create the wallet
    const { data: existingWallet } = await supabase
        .from("wallets")
        .select("id, balance, lifetime_earned")
        .eq("customer_id", customer.id)
        .eq("business_id", body.business_id)
        .maybeSingle();

    if (existingWallet) {
        return jsonResponse({
            wallet_id: existingWallet.id,
            customer_id: customer.id,
            balance: Number(existingWallet.balance),
            lifetime_earned: Number(existingWallet.lifetime_earned),
            created: false,
        });
    }

    const { data: wallet, error: wErr } = await supabase
        .from("wallets")
        .insert({
            customer_id: customer.id,
            business_id: body.business_id,
        })
        .select("id, balance, lifetime_earned")
        .single();

    if (wErr || !wallet) {
        return errorResponse(`Wallet creation failed: ${wErr?.message}`, 500);
    }

    return jsonResponse({
        wallet_id: wallet.id,
        customer_id: customer.id,
        balance: Number(wallet.balance),
        lifetime_earned: Number(wallet.lifetime_earned),
        created: true,
    }, 201);
});
