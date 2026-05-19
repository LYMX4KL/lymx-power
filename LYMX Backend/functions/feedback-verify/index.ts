// =============================================================================
// LYMX Power — Feedback Verify Endpoint (public, token-based)
// =============================================================================
// POST /functions/v1/feedback-verify
//
// Public endpoint — NO AUTH REQUIRED. The submitter clicks Confirm/Still-broken
// in their email which lands on verify-fix.html, which calls this endpoint.
// Token is the proof; it's one-time-use.
//
// REQUEST BODY:
//   {
//     "feedback_id": "uuid",
//     "token": "uuid",                    // the verification_token
//     "action": "confirm" | "still",
//     "note": "optional submitter note"
//   }
//
// RESPONSE (200):
//   { success: true, new_status: "resolved" | "in_progress" }
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

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return errorResponse("Method not allowed", 405);

    let body;
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON", 400); }
    const { feedback_id, token, action, note } = body || {};
    if (!feedback_id || !token || !action) return errorResponse("Missing feedback_id, token, or action", 400);
    if (action !== "confirm" && action !== "still") return errorResponse("Invalid action", 400);

    const supabase = createClient(
        Deno.env.get("SUPABASE_URL"),
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    );

    // Look up feedback by token + id (defense-in-depth: both must match)
    const { data: fb, error: fbErr } = await supabase
        .from("feedback")
        .select("id, verification_token, verification_token_used_at, user_email, user_id, status")
        .eq("id", feedback_id)
        .single();
    if (fbErr || !fb) return errorResponse("Feedback not found", 404);
    if (!fb.verification_token || fb.verification_token !== token) return errorResponse("Invalid token", 403);
    if (fb.verification_token_used_at) return errorResponse("Token already used", 410);

    const verificationStatus = action === "confirm" ? "confirmed" : "still_broken";
    const newStatus = action === "confirm" ? "resolved" : "in_progress";

    // Insert the submitter response
    await supabase.from("feedback_replies").insert({
        feedback_id,
        author_id: fb.user_id,
        author_email: fb.user_email,
        author_name: "Submitter (via verify link)",
        author_role: "submitter",
        kind: "submitter_response",
        body_text: action === "confirm"
            ? "✓ Confirmed — the fix works." + (note ? " Note: " + note : "")
            : "✗ Still broken." + (note ? " Note: " + note : ""),
        verification_status: verificationStatus,
        verified_at: new Date().toISOString(),
    });

    // Mark token used + update feedback status + clear awaiting_verification
    const updatePatch = {
        verification_token_used_at: new Date().toISOString(),
        awaiting_verification: false,
        status: newStatus,
    };
    if (action === "confirm") {
        updatePatch.resolved_at = new Date().toISOString();
    }

    await supabase.from("feedback").update(updatePatch).eq("id", feedback_id);

    return json({
        success: true,
        action,
        new_status: newStatus,
        verification_status: verificationStatus,
    });
});
