// =============================================================================
// LYMX Power — reactivate-staff
// =============================================================================
// POST /functions/v1/reactivate-staff
//
// Inverse of revoke-staff-access. Clears the auth ban + flips staff_profiles
// back to active. Used for:
//   • Accidental terminations
//   • Rehires (legacy staff coming back)
//
// AUTH: caller must satisfy am_i_hr_or_admin().
//
// REQUEST BODY:
//   { profile_id: uuid, reason: string, rehire?: boolean, new_start_date?: 'YYYY-MM-DD' }
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
    if (!body.reason || String(body.reason).trim().length < 10) {
        return err("Reason required (>=10 chars) for audit trail");
    }

    const profileId = String(body.profile_id);
    const reason = String(body.reason).trim();
    const isRehire = !!body.rehire;
    const newStartDate = body.new_start_date ? String(body.new_start_date) : null;

    // 1. Clear ban
    const { error: banErr } = await supa.auth.admin.updateUserById(profileId, {
        ban_duration: "none",
    });
    if (banErr) {
        // Fallback path — clear user_metadata revoke flags
        console.warn("ban clear failed, trying metadata fallback:", banErr.message);
        const { data: u } = await supa.auth.admin.getUserById(profileId);
        const meta = { ...(u?.user?.user_metadata || {}) };
        delete meta.lymx_access_revoked;
        delete meta.lymx_revoked_at;
        delete meta.lymx_revoked_reason;
        const { error: fbErr } = await supa.auth.admin.updateUserById(profileId, { user_metadata: meta });
        if (fbErr) return err("Auth unban failed: " + fbErr.message, 500);
    }

    // 2. Flip staff_profiles
    const profileUpdate: Record<string, unknown> = {
        is_active: true,
        employment_status: isRehire ? "active" : "active",
        termination_date: null,
    };
    if (isRehire && newStartDate) {
        profileUpdate.hire_date = newStartDate; // overwrite with new hire date for rehire
    }
    const { error: profErr } = await supa.from("staff_profiles").update(profileUpdate).eq("user_id", profileId);
    if (profErr) return err("staff_profiles update failed: " + profErr.message, 500);

    // 3. Log a marker write-up (visibility for audit)
    try {
        await supa.from("personnel_write_ups").insert({
            profile_id: profileId,
            issued_by: callerId,
            severity: "info",
            category: "admin_action",
            description: (isRehire ? "REHIRE" : "REACTIVATION") + " — " + reason,
            status: "closed",
            closed_at: new Date().toISOString(),
            closed_by: callerId,
        });
    } catch (e) {
        // non-fatal — write_up insert may fail if severity='info' isn't in the enum yet
        console.warn("audit write_up insert failed (non-fatal):", e);
    }

    return json({
        ok: true,
        profile_id: profileId,
        reactivated_by: callerId,
        reactivated_at: new Date().toISOString(),
        rehire: isRehire,
        new_start_date: newStartDate,
        reason,
    });
});
