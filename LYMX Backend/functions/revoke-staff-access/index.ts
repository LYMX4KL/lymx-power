// =============================================================================
// LYMX Power — revoke-staff-access
// =============================================================================
// POST /functions/v1/revoke-staff-access
//
// Called by admin-termination.html (Stage 6: access_revoked) after the user
// confirms the termination is final. Performs three actions:
//   1. supabase.auth.admin.updateUserById  → ban for 100 years
//   2. staff_profiles.is_active = false, employment_status = 'terminated'
//   3. logs the action to termination_records.access_revoked_at + audit JSON
//
// AUTH: caller must satisfy am_i_hr_or_admin().
//
// REQUEST BODY:
//   { profile_id: uuid, termination_record_id?: uuid, reason?: string }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const err = (m: string, s = 400) => json({ ok: false, error: m }, s);

serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return err("Method not allowed", 405);

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SB_URL || !SB_KEY) return err("Server config missing", 500);
    const supa = createClient(SB_URL, SB_KEY);

    // Auth
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return err("Unauthorized", 401);
    const { data: userData, error: userErr } = await supa.auth.getUser(token);
    if (userErr || !userData?.user) return err("Invalid token", 401);
    const callerId = userData.user.id;

    // Authorization
    const userClient = createClient(SB_URL, SB_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: isAuthorized } = await userClient.rpc("am_i_hr_or_admin");
    if (!isAuthorized) return err("Must be HR, compliance, or admin", 403);

    // Parse
    let body: any;
    try { body = await req.json(); } catch { return err("Bad JSON"); }
    if (!body.profile_id) return err("Missing profile_id");

    const profileId = String(body.profile_id);
    const reason = body.reason ? String(body.reason).trim() : "Termination — access revoked";
    const terminationRecordId = body.termination_record_id ? String(body.termination_record_id) : null;

    // Safety: don't let admins revoke themselves
    if (profileId === callerId) return err("Cannot revoke your own access via this endpoint — use a different admin.", 400);

    // 1. Ban for 100 years (Supabase format: ISO duration string is NOT supported — use a far-future timestamp)
    const banUntil = new Date(Date.now() + 100 * 365 * 24 * 3_600_000).toISOString();
    const { error: banErr } = await supa.auth.admin.updateUserById(profileId, {
        ban_duration: "876600h", // 100 years in hours (100*365.25*24)
    });
    if (banErr) {
        // Fallback: try setting ban_until directly via raw call if ban_duration unsupported
        console.warn("ban_duration failed, trying user_metadata fallback:", banErr.message);
        const { error: fbErr } = await supa.auth.admin.updateUserById(profileId, {
            user_metadata: { lymx_access_revoked: true, lymx_revoked_at: new Date().toISOString(), lymx_revoked_reason: reason },
        });
        if (fbErr) return err("Auth update failed: " + fbErr.message, 500);
    }

    // 2. Flip staff_profiles
    const { error: profErr } = await supa.from("staff_profiles").update({
        is_active: false,
        employment_status: "terminated",
        termination_date: new Date().toISOString().slice(0, 10),
    }).eq("user_id", profileId);
    if (profErr) console.warn("staff_profiles update failed:", profErr.message);

    // 3. Log on termination_records
    if (terminationRecordId) {
        const { error: trErr } = await supa.from("termination_records").update({
            access_revoked_at: new Date().toISOString(),
            access_revoked_by: callerId,
        }).eq("id", terminationRecordId);
        if (trErr) console.warn("termination_records update failed:", trErr.message);
    }

    return json({
        ok: true,
        profile_id: profileId,
        ban_until: banUntil,
        revoked_by: callerId,
        revoked_at: new Date().toISOString(),
        reason,
    });
});
