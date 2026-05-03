// =============================================================================
// LYMX Power — Partner Email Acknowledgement Endpoint
// =============================================================================
// POST /functions/v1/partner-acknowledge-email
//
// Called when a partner clicks "I've set up my Gmail Send-mail-as" in their
// dashboard (or via a link in the welcome email). Flips
// `partner_emails.partner_acknowledged_at = now()` for the calling partner.
//
// We could let partners do this via the auto-generated REST API (RLS in
// migration 005 permits it) but going through a dedicated endpoint:
//   - gives us a clean URL to ping from buttons / email links
//   - lets us add audit logging / metrics later without a schema change
//   - keeps the public API surface explicit instead of leaning on table
//     names being part of the contract
//
// AUTH: User JWT only. The partner row is looked up via auth.uid(). Anyone
//   with a valid auth token who is also a partner can call this for their
//   OWN partner_emails row — RLS prevents touching anyone else's.
//
// REQUEST BODY (JSON): empty (or `{}`)
//
// RESPONSE (200):
// {
//   "success":             true,
//   "partner_email_id":    "uuid",
//   "full_email":          "maya.chen@getlymx.com",
//   "acknowledged_at":     "2026-05-03T22:31:00.000Z",
//   "already_acknowledged": false
// }
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


serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
        return errorResponse("Method not allowed", 405);
    }

    // ---- Auth: user JWT -----------------------------------------------------
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
        return errorResponse("Missing Authorization header", 401);
    }

    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } }
    );

    // Verify the JWT and get the user
    const { data: { user }, error: uErr } = await supabase.auth.getUser(
        authHeader.replace("Bearer ", "")
    );
    if (uErr || !user) {
        return errorResponse("Invalid auth token", 401);
    }

    // ---- Look up the calling user's partner row -----------------------------
    const { data: partner, error: pErr } = await supabase
        .from("partners")
        .select("id, archived_at")
        .eq("user_id", user.id)
        .maybeSingle();
    if (pErr) {
        return errorResponse(`Partner lookup failed: ${pErr.message}`, 500);
    }
    if (!partner) {
        return errorResponse("Caller is not a partner", 403);
    }
    if (partner.archived_at) {
        return errorResponse("Partner is archived", 400);
    }

    // ---- Look up their partner_emails row ----------------------------------
    const { data: row, error: lookupErr } = await supabase
        .from("partner_emails")
        .select("id, full_email, status, partner_acknowledged_at")
        .eq("partner_id", partner.id)
        .maybeSingle();
    if (lookupErr) {
        return errorResponse(`partner_emails lookup failed: ${lookupErr.message}`, 500);
    }
    if (!row) {
        return errorResponse(
            "No provisioned email yet — nothing to acknowledge",
            404
        );
    }
    if (row.status !== "active") {
        return errorResponse(
            `Cannot acknowledge a ${row.status} email — current status: ${row.status}`,
            400
        );
    }

    // ---- Idempotency: if already acknowledged, return current state --------
    if (row.partner_acknowledged_at) {
        return jsonResponse({
            success: true,
            partner_email_id: row.id,
            full_email: row.full_email,
            acknowledged_at: row.partner_acknowledged_at,
            already_acknowledged: true,
        });
    }

    // ---- Flip partner_acknowledged_at --------------------------------------
    const now = new Date().toISOString();
    const { error: updateErr } = await supabase
        .from("partner_emails")
        .update({ partner_acknowledged_at: now })
        .eq("id", row.id);
    if (updateErr) {
        return errorResponse(`Update failed: ${updateErr.message}`, 500);
    }

    return jsonResponse({
        success: true,
        partner_email_id: row.id,
        full_email: row.full_email,
        acknowledged_at: now,
        already_acknowledged: false,
    });
});
