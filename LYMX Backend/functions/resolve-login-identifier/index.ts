// =============================================================================
// LYMX Power — resolve-login-identifier
// =============================================================================
// POST /functions/v1/resolve-login-identifier
//
// PUBLIC endpoint (no auth required). Frontend calls this BEFORE
// signInWithPassword and BEFORE /auth/v1/recover, to translate whatever
// identifier the user typed (phone number, personal email, company email)
// into the auth.users primary email that Supabase needs.
//
// Per ARCHITECTURE-RULES Rule 0 (root cause): the gate-keeping bug today
// (pw-reset emails never arrive) has two stacked root causes — wrong
// identifier looking up no user, AND pw-reset routing through Cloudflare
// when the user's auth email is *@getlymx.com. Migration 073 fixes the
// second by swapping auth emails to personal addresses. THIS function
// fixes the first by accepting any identifier and resolving to the
// correct underlying auth account.
//
// REQUEST BODY (JSON):
//   { "identifier": "anything-the-user-typed" }
//
// RESPONSE (200, found):
//   {
//     "found": true,
//     "auth_user_id": "uuid",
//     "primary_email": "...",   // pass this to /recover or signInWithPassword
//     "primary_phone": "+1...",
//     "matched_type":  "personal_email" | "phone" | "company_email",
//     "matched_value": "normalized-form-we-found"
//   }
//
// RESPONSE (200, not found):
//   { "found": false }
//
// Note: we DELIBERATELY return 200 with found:false instead of 404 so that
// when the frontend uses this to gate a pw-reset, an attacker can't easily
// enumerate registered identifiers via HTTP status codes. The frontend
// also displays the same "If that email is registered..." message in
// both cases so behavior is identical.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
        return errorResponse("Method not allowed", 405);
    }

    let body: { identifier?: string };
    try {
        body = await req.json();
    } catch {
        return errorResponse("Invalid JSON body", 400);
    }
    const identifier = (body?.identifier ?? "").toString().trim();
    if (!identifier) {
        return jsonResponse({ found: false, reason: "empty identifier" });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY")
        || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SERVICE_KEY) {
        return errorResponse("Server misconfigured: missing SUPABASE_URL or SERVICE_ROLE_KEY", 500);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { persistSession: false },
    });

    const { data, error } = await supabase.rpc("resolve_login_identifier", {
        p_identifier: identifier,
    });

    if (error) {
        // Don't leak DB error details to the public; log + return generic
        console.error("resolve_login_identifier RPC error:", error.message);
        return jsonResponse({ found: false, reason: "lookup failed" });
    }

    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
    if (!row || !row.auth_user_id) {
        return jsonResponse({ found: false });
    }

    return jsonResponse({
        found: true,
        auth_user_id: row.auth_user_id,
        primary_email: row.primary_email,
        primary_phone: row.primary_phone,
        matched_type: row.matched_type,
        matched_value: row.matched_value,
    });
});
