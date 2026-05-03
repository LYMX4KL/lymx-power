// =============================================================================
// LYMX Power — Square OAuth Callback Endpoint
// =============================================================================
// GET /functions/v1/square-oauth-callback?code=...&state=...
//
// Step 2 of Square's OAuth flow — Square redirects the merchant's browser
// here after they approve our app. We:
//   1. Verify the state token's HMAC + freshness (10-min window)
//   2. Extract business_id from the state
//   3. Exchange the auth code for an access_token via Square's /oauth2/token
//   4. Fetch the merchant info from Square's /v2/merchants/me
//   5. UPSERT the result into `square_integrations` (so reconnect works)
//   6. Redirect the merchant's browser back to the LYMX dashboard
//
// AUTH: Public endpoint — Square redirects an unauthenticated browser here.
//   The state token IS the auth: only flows we initiated have valid state,
//   and the HMAC + ts together prevent CSRF + replay attacks.
//
// METHOD: GET (Square uses GET for OAuth callbacks, not POST).
//
// SUCCESS REDIRECT: `${LYMX_SITE_URL}/dashboard?square=connected`
// FAILURE REDIRECT: `${LYMX_SITE_URL}/dashboard?square=error&reason=...`
//
// We redirect rather than returning JSON because this is hit by a browser
// navigation, not an XHR — the user expects a page, not a payload.
//
// IDEMPOTENCY: square_integrations has UNIQUE on square_merchant_id, so we
//   use INSERT ... ON CONFLICT DO UPDATE. If the same merchant reconnects
//   (after a previous disconnect), we update the existing row.
//
// ENV VARS REQUIRED:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   SQUARE_APP_ID
//   SQUARE_APP_SECRET              — secret half of OAuth client (do NOT log)
//   SQUARE_OAUTH_REDIRECT_URI      — must match what was sent in init step
//   SQUARE_ENV                     — "sandbox" or "production"
//   SQUARE_STATE_SIGNING_SECRET    — same secret used in init
//   LYMX_SITE_URL                  — where to send the merchant on success/fail
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// --- CORS + response helpers (we mostly redirect, but errors need CORS) ----
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

// =============================================================================
// Helpers
// =============================================================================

function squareApiHost(env: string): string {
    return env === "production"
        ? "https://connect.squareup.com"
        : "https://connect.squareupsandbox.com";
}

function base64urlDecode(input: string): string {
    // Add padding back, swap URL-safe chars
    const padded = input + "=".repeat((4 - input.length % 4) % 4);
    const std = padded.replace(/-/g, "+").replace(/_/g, "/");
    return atob(std);
}

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
 * Verify a state token built by square-oauth-init.
 * Returns the embedded business_id on success, throws on any verification failure.
 */
async function verifyStateToken(
    secret: string,
    state: string
): Promise<{ business_id: string }> {
    const lastDot = state.lastIndexOf(".");
    if (lastDot < 1) throw new Error("State token malformed");
    const payload = state.slice(0, lastDot);
    const signature = state.slice(lastDot + 1);

    // Recompute HMAC and compare. Constant-time-ish — acceptable for short hex.
    const expected = await hmacSha256Hex(secret, payload);
    if (expected !== signature) throw new Error("State token signature mismatch");

    let parsed: { business_id?: string; ts?: number };
    try {
        parsed = JSON.parse(base64urlDecode(payload));
    } catch {
        throw new Error("State token payload not JSON");
    }
    if (!parsed.business_id || typeof parsed.business_id !== "string") {
        throw new Error("State token missing business_id");
    }
    if (typeof parsed.ts !== "number") {
        throw new Error("State token missing ts");
    }
    if (Date.now() - parsed.ts > STATE_MAX_AGE_MS) {
        throw new Error("State token expired (>10 min old)");
    }
    return { business_id: parsed.business_id };
}

/**
 * Exchange the auth code for an access_token via Square's /oauth2/token endpoint.
 * Returns the token response which includes:
 *   { access_token, token_type, expires_at, merchant_id, refresh_token, ... }
 */
async function exchangeCodeForToken(args: {
    apiHost: string;
    appId: string;
    appSecret: string;
    code: string;
}): Promise<{
    access_token: string;
    refresh_token: string;
    expires_at: string; // ISO 8601
    merchant_id: string;
    token_type: string;
}> {
    const url = `${args.apiHost}/oauth2/token`;
    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Square-Version": "2025-01-23",
        },
        body: JSON.stringify({
            client_id: args.appId,
            client_secret: args.appSecret,
            code: args.code,
            grant_type: "authorization_code",
        }),
    });
    const json = await resp.json();
    if (!resp.ok) {
        // Square returns { errors: [{ category, code, detail }, ...] }
        const detail = json.errors?.map((e: { detail?: string; code?: string }) =>
            e.detail ?? e.code).join("; ") ?? resp.statusText;
        throw new Error(`Square token exchange ${resp.status}: ${detail}`);
    }
    if (!json.access_token || !json.refresh_token || !json.merchant_id) {
        throw new Error("Square token response missing required fields");
    }
    return json;
}

/**
 * Fetch the merchant's main location ID via Square's /v2/locations.
 * The token-exchange response gives us merchant_id but not the main location;
 * we need the location_id to map incoming payment webhooks to a business.
 */
async function fetchMainLocationId(args: {
    apiHost: string;
    accessToken: string;
}): Promise<string | null> {
    const resp = await fetch(`${args.apiHost}/v2/locations`, {
        headers: {
            "Authorization": `Bearer ${args.accessToken}`,
            "Square-Version": "2025-01-23",
        },
    });
    if (!resp.ok) {
        // Non-fatal — we can still complete the integration without the main
        // location. The webhook handler will handle multi-location merchants
        // generically anyway.
        return null;
    }
    const json = await resp.json();
    const locations = (json.locations ?? []) as Array<{
        id: string;
        type?: string;
        status?: string;
    }>;
    // Prefer ACTIVE locations. Square doesn't have a "primary" flag, so we
    // pick the first one. Multi-location handling is Phase 5+.
    const active = locations.find((l) => l.status === "ACTIVE");
    return active?.id ?? locations[0]?.id ?? null;
}


// =============================================================================
// Main handler
// =============================================================================

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    // Resolve LYMX_SITE_URL early so error redirects always work
    const siteUrl = Deno.env.get("LYMX_SITE_URL") ?? "https://getlymx.com";

    // Helper: redirect back to LYMX with a status param
    const redirectWith = (params: Record<string, string>) => {
        const target = new URL("/dashboard", siteUrl);
        for (const [k, v] of Object.entries(params)) {
            target.searchParams.set(k, v);
        }
        return Response.redirect(target.toString(), 302);
    };

    // ---- Square reported an error (user denied, etc.) ----------------------
    if (error) {
        return redirectWith({
            square: "error",
            reason: error,
        });
    }
    if (!code || !state) {
        return redirectWith({
            square: "error",
            reason: "missing_code_or_state",
        });
    }

    // ---- Env var sanity ----------------------------------------------------
    const env = (k: string) => Deno.env.get(k);
    const required = [
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SQUARE_APP_ID",
        "SQUARE_APP_SECRET",
        "SQUARE_OAUTH_REDIRECT_URI",
        "SQUARE_STATE_SIGNING_SECRET",
    ];
    const missing = required.filter((k) => !env(k));
    if (missing.length > 0) {
        console.error(`[square-oauth-callback] Missing env vars: ${missing.join(",")}`);
        return redirectWith({
            square: "error",
            reason: "server_misconfigured",
        });
    }

    // ---- Verify state -------------------------------------------------------
    let business_id: string;
    try {
        ({ business_id } = await verifyStateToken(
            env("SQUARE_STATE_SIGNING_SECRET")!,
            state
        ));
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[square-oauth-callback] State verification failed: ${msg}`);
        return redirectWith({
            square: "error",
            reason: "invalid_state",
        });
    }

    // ---- Exchange the code for an access token ------------------------------
    const sqEnv = env("SQUARE_ENV") ?? "sandbox";
    const apiHost = squareApiHost(sqEnv);
    let tokenResp: Awaited<ReturnType<typeof exchangeCodeForToken>>;
    try {
        tokenResp = await exchangeCodeForToken({
            apiHost,
            appId: env("SQUARE_APP_ID")!,
            appSecret: env("SQUARE_APP_SECRET")!,
            code,
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[square-oauth-callback] Token exchange failed: ${msg}`);
        return redirectWith({
            square: "error",
            reason: "token_exchange_failed",
        });
    }

    // ---- Fetch the merchant's main location (best-effort) -------------------
    let mainLocationId: string | null = null;
    try {
        mainLocationId = await fetchMainLocationId({
            apiHost,
            accessToken: tokenResp.access_token,
        });
    } catch (e) {
        // Non-fatal — log and continue. The integration still works without it.
        console.error(`[square-oauth-callback] Main location fetch failed (non-fatal):`, e);
    }

    // ---- UPSERT into square_integrations ------------------------------------
    const supabase = createClient(
        env("SUPABASE_URL")!,
        env("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } }
    );

    const { error: upsertErr } = await supabase
        .from("square_integrations")
        .upsert({
            business_id,
            square_merchant_id: tokenResp.merchant_id,
            square_main_location_id: mainLocationId,
            access_token: tokenResp.access_token,
            refresh_token: tokenResp.refresh_token,
            token_expires_at: tokenResp.expires_at,
            issuance_enabled: true,
            connected_at: new Date().toISOString(),
            disconnected_at: null,  // clear if reconnecting after a disconnect
        }, {
            onConflict: "square_merchant_id",
        });
    if (upsertErr) {
        console.error(`[square-oauth-callback] DB upsert failed: ${upsertErr.message}`);
        return redirectWith({
            square: "error",
            reason: "db_write_failed",
        });
    }

    // ---- All good — redirect back to LYMX dashboard ------------------------
    return redirectWith({
        square: "connected",
        merchant_id: tokenResp.merchant_id,
    });
});
