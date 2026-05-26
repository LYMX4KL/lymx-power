// =============================================================================
// LYMX Power — Google OAuth callback (Calendar sync)
// =============================================================================
// POST /functions/v1/google-oauth-callback
//
// Called by /google-oauth-done.html after Google redirects back with a code.
// Exchanges the auth code for tokens, stores them in oauth_tokens for the
// signed-in user.
//
// REQUIRES (Supabase Edge Function Secrets):
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//   GOOGLE_OAUTH_REDIRECT_URL   (e.g. https://getlymx.com/google-oauth-done.html)
//
// REQUEST BODY:
//   { code: "<auth code from Google>", user_id?: "<optional, defaults to JWT user>" }
//
// RESPONSE:
//   { ok: true, provider_email, scope, expires_at }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const err = (m: string, s = 400) => json({ ok: false, error: m }, s);

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return err("Method not allowed", 405);

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
    const CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
    const REDIRECT_URL = Deno.env.get("GOOGLE_OAUTH_REDIRECT_URL");
    if (!SB_URL || !SB_KEY) return err("Server config missing", 500);
    if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URL) return err("Google OAuth not configured — set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URL in Supabase secrets", 500);

    const supabase = createClient(SB_URL, SB_KEY);

    // Resolve calling user from JWT
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return err("Unauthorized", 401);
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return err("Invalid token", 401);
    const userId = userData.user.id;

    // Parse body
    let body: any;
    try { body = await req.json(); } catch { return err("Invalid JSON", 400); }
    const code = String(body.code || "").trim();
    if (!code) return err("code is required", 400);

    // Exchange code for tokens
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            code,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: REDIRECT_URL,
            grant_type: "authorization_code",
        }).toString(),
    });
    if (!tokenResp.ok) {
        const errBody = await tokenResp.text().catch(() => "");
        return err(`Google token exchange failed (${tokenResp.status}): ${errBody.slice(0, 300)}`, 502);
    }
    const tokens = await tokenResp.json();
    // tokens shape: { access_token, refresh_token, expires_in, scope, token_type, id_token? }

    // Decode id_token if present to get the email + sub (no signature verify; trust the channel since the request came directly from Google)
    let providerEmail: string | null = null;
    let providerSub: string | null = null;
    if (tokens.id_token) {
        try {
            const parts = tokens.id_token.split(".");
            const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
            providerEmail = payload.email || null;
            providerSub = payload.sub || null;
        } catch (e) { console.warn('[google-oauth-callback:89] best-effort step failed:', (e as Error).message); }
    }
    // If no id_token, hit Google's userinfo endpoint instead
    if (!providerEmail && tokens.access_token) {
        try {
            const u = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { "Authorization": `Bearer ${tokens.access_token}` } });
            if (u.ok) {
                const j = await u.json();
                providerEmail = j.email || providerEmail;
                providerSub = j.sub || providerSub;
            }
        } catch (e) { console.warn('[google-oauth-callback:100] best-effort step failed:', (e as Error).message); }
    }

    const expiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null;

    const { error: upsertErr } = await supabase
        .from("oauth_tokens")
        .upsert({
            user_id: userId,
            provider: "google",
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token || null,
            token_type: tokens.token_type || "Bearer",
            scope: tokens.scope || null,
            expires_at: expiresAt,
            provider_account_id: providerSub,
            provider_email: providerEmail,
            last_refreshed_at: new Date().toISOString(),
        }, { onConflict: "user_id,provider" });
    if (upsertErr) return err(`Could not store tokens: ${upsertErr.message}`, 500);

    return json({
        ok: true,
        provider_email: providerEmail,
        scope: tokens.scope,
        expires_at: expiresAt,
        has_refresh_token: !!tokens.refresh_token,
    });
});
