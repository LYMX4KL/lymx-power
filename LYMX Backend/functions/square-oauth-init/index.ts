// =============================================================================
// LYMX Power — Square OAuth Init Endpoint
// =============================================================================
// POST /functions/v1/square-oauth-init
//
// Step 1 of Square's OAuth flow: a business owner clicks "Connect Square" in
// their LYMX dashboard. This endpoint returns the Square authorization URL
// they should be redirected to. Square then bounces them back to our
// `square-oauth-callback` endpoint with an auth code.
//
// HOW THE FLOW LOOKS:
//   1. Biz owner clicks "Connect Square" → POST here
//   2. Frontend gets {auth_url}, redirects browser to Square
//   3. Square shows merchant the consent screen, they approve
//   4. Square redirects to our callback URL with `?code=...&state=...`
//   5. Callback verifies state, exchanges code for access_token, stores it
//
// AUTH: Business owner JWT only. We use auth.getUser() to identify them and
//   then check ownership of the requested business_id.
//
// THE STATE TOKEN:
//   Square requires a `state` param it'll echo back on the callback. We use
//   it for two things:
//   1. CSRF protection — make sure the callback came from a flow we initiated
//   2. Stash the business_id so the callback knows which business to bind to
//
//   Format: base64url(JSON({business_id, ts, nonce})).hmac(secret)
//   Verified on the callback by re-computing the HMAC. Expires after 10 min.
//
// REQUEST BODY (JSON):
// {
//   "business_id": "uuid"
// }
//
// RESPONSE (200):
// {
//   "auth_url": "https://connect.squareup.com/oauth2/authorize?client_id=...",
//   "state":    "base64url.hmacHex"        // returned for client logging only
// }
//
// ENV VARS REQUIRED:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   SQUARE_APP_ID                  — public Application ID from Square dashboard
//   SQUARE_OAUTH_REDIRECT_URI      — must match what's set in Square app config
//                                    e.g. https://apffootxzfwmtyjlnteo.supabase.co
//                                          /functions/v1/square-oauth-callback
//   SQUARE_ENV                     — "sandbox" or "production" (default: sandbox)
//   SQUARE_STATE_SIGNING_SECRET    — random ≥32-char string; never share
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// --- CORS + response helpers -----------------------------------------------
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

interface InitBody {
    business_id: string;
}

// =============================================================================
// Helpers
// =============================================================================

/** Square OAuth scopes we need — keep minimal. */
const SQUARE_SCOPES = [
    "MERCHANT_PROFILE_READ",  // pull merchant_id + main location for our DB
    "PAYMENTS_READ",          // listen to payment webhooks (the whole point)
].join(" ");

/** Square's authorization URL host varies by env. */
function squareAuthHost(env: string): string {
    return env === "production"
        ? "https://connect.squareup.com"
        : "https://connect.squareupsandbox.com";
}

/** Base64url-encode a string (RFC 4648 §5, no padding). */
function base64urlEncode(input: string): string {
    return btoa(input)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

/** Compute HMAC-SHA256 hex of `data` keyed by `secret`. */
async function hmacSha256Hex(secret: string, data: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
    return Array.from(new Uint8Array(sig))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * Build a signed state token: `payload.signature` where
 * payload = base64url(JSON({business_id, ts, nonce})).
 *
 * The callback verifies by recomputing the HMAC over `payload`. The `ts`
 * field bounds the token's validity window (10 minutes).
 */
async function buildStateToken(
    secret: string,
    businessId: string
): Promise<string> {
    // Random 16-byte nonce, hex-encoded
    const nonceBytes = new Uint8Array(16);
    crypto.getRandomValues(nonceBytes);
    const nonce = Array.from(nonceBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    const payloadJson = JSON.stringify({
        business_id: businessId,
        ts: Date.now(),
        nonce,
    });
    const payload = base64urlEncode(payloadJson);
    const signature = await hmacSha256Hex(secret, payload);
    return `${payload}.${signature}`;
}


// =============================================================================
// Main handler
// =============================================================================

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
        return errorResponse("Method not allowed", 405);
    }

    // ---- Auth: user JWT (must be the business owner) ------------------------
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
        return errorResponse("Missing Authorization header", 401);
    }

    // ---- Body ----------------------------------------------------------------
    let body: InitBody;
    try {
        body = await req.json();
    } catch {
        return errorResponse("Invalid JSON", 400);
    }
    if (!body.business_id || typeof body.business_id !== "string") {
        return errorResponse("business_id (uuid) is required", 400);
    }

    // ---- Env var sanity ------------------------------------------------------
    const env = (k: string) => Deno.env.get(k);
    const required = [
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SQUARE_APP_ID",
        "SQUARE_OAUTH_REDIRECT_URI",
        "SQUARE_STATE_SIGNING_SECRET",
    ];
    const missing = required.filter((k) => !env(k));
    if (missing.length > 0) {
        return errorResponse(
            `Server misconfigured — missing env vars: ${missing.join(", ")}`,
            500
        );
    }

    const supabase = createClient(
        env("SUPABASE_URL")!,
        env("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } }
    );

    // Verify the JWT and get the user
    const { data: { user }, error: uErr } = await supabase.auth.getUser(
        authHeader.replace("Bearer ", "")
    );
    if (uErr || !user) {
        return errorResponse("Invalid auth token", 401);
    }

    // ---- Verify business ownership -----------------------------------------
    const { data: biz, error: bErr } = await supabase
        .from("businesses")
        .select("id, owner_user_id, archived_at")
        .eq("id", body.business_id)
        .maybeSingle();
    if (bErr) {
        return errorResponse(`Business lookup failed: ${bErr.message}`, 500);
    }
    if (!biz) {
        return errorResponse("Business not found", 404);
    }
    if (biz.archived_at) {
        return errorResponse("Business is archived", 400);
    }
    if (biz.owner_user_id !== user.id) {
        return errorResponse("Not the business owner", 403);
    }

    // ---- Build the signed state token ---------------------------------------
    const state = await buildStateToken(
        env("SQUARE_STATE_SIGNING_SECRET")!,
        body.business_id
    );

    // ---- Build the Square authorization URL --------------------------------
    const sqEnv = env("SQUARE_ENV") ?? "sandbox";
    const authHost = squareAuthHost(sqEnv);
    const params = new URLSearchParams({
        client_id: env("SQUARE_APP_ID")!,
        scope: SQUARE_SCOPES,
        redirect_uri: env("SQUARE_OAUTH_REDIRECT_URI")!,
        state,
        session: "false",  // forces re-auth — better UX than reusing a stale Square session
    });
    const auth_url = `${authHost}/oauth2/authorize?${params.toString()}`;

    return jsonResponse({ auth_url, state });
});
