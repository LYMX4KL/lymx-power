// =============================================================================
// LYMX Power — provision-hire
// =============================================================================
// POST /functions/v1/provision-hire   { offer_id: uuid }
//
// HR-provisions-on-accept (Kenny, 2026-05-30). Turns an accepted/sent offer
// into a real staff member:
//   1. Creates (or locates) the candidate's auth account from their application
//      email.
//   2. Calls provision_hire(offer_id, user_id) — idempotent: links the account,
//      accepts the offer, and ensures the staff_profile + onboarding tasks
//      (mig 157).
//   3. Best-effort: emails the new hire a set-password link.
//
// AUTH: caller must satisfy am_i_hr_or_admin().
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

    // --- Authenticate caller ---
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return err("Unauthorized", 401);
    const { data: userData, error: userErr } = await supa.auth.getUser(token);
    if (userErr || !userData?.user) return err("Invalid token", 401);

    // --- Authorize: HR or admin only ---
    const userClient = createClient(SB_URL, SB_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: isAuthorized } = await userClient.rpc("am_i_hr_or_admin");
    if (!isAuthorized) return err("Must be HR or admin", 403);

    // --- Parse ---
    let body: any;
    try { body = await req.json(); } catch { return err("Bad JSON"); }
    const offerId = body?.offer_id ? String(body.offer_id) : "";
    if (!offerId) return err("Missing offer_id");

    // --- Read offer + applicant ---
    const { data: offer, error: oErr } = await supa
        .from("offers")
        .select("id, application_id, status, applicant_profile_id, title")
        .eq("id", offerId)
        .single();
    if (oErr || !offer) return err("Offer not found", 404);

    let email = "", firstName = "", lastName = "";
    if (offer.application_id) {
        const { data: app } = await supa
            .from("job_applications")
            .select("email, first_name, last_name")
            .eq("id", offer.application_id)
            .single();
        if (app) { email = (app.email || "").trim(); firstName = app.first_name || ""; lastName = app.last_name || ""; }
    }
    if (!email) return err("Applicant has no email on file — cannot provision an account.", 422);

    // --- Resolve or create the auth account ---
    let userId = offer.applicant_profile_id || null;
    let created = false;
    if (!userId) {
        const { data: existing } = await supa.rpc("find_auth_user_by_email", { p_email: email });
        if (existing) {
            userId = existing as string;
        } else {
            const { data: cu, error: cErr } = await supa.auth.admin.createUser({
                email,
                email_confirm: true,
                user_metadata: { full_name: [firstName, lastName].filter(Boolean).join(" ") },
            });
            if (cErr || !cu?.user) {
                // Possible race: created between our lookup and now — try once more.
                const { data: again } = await supa.rpc("find_auth_user_by_email", { p_email: email });
                if (!again) return err("Could not create the hire's account: " + (cErr?.message || "unknown"), 500);
                userId = again as string;
            } else {
                userId = cu.user.id;
                created = true;
            }
        }
    }

    // --- Provision: link account + accept + staff_profile + onboarding ---
    const { data: prov, error: pErr } = await supa.rpc("provision_hire", { p_offer_id: offerId, p_user_id: userId });
    if (pErr) return err("Provisioning failed: " + pErr.message, 500);

    // --- Best-effort: send a set-password / welcome link ---
    let emailSent = false;
    try {
        const { data: link } = await supa.auth.admin.generateLink({ type: "recovery", email });
        const actionUrl = (link as any)?.properties?.action_link || "";
        const resp = await fetch(SB_URL + "/functions/v1/send-email", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SB_KEY },
            body: JSON.stringify({
                channel: "transactional",
                recipient_email: email,
                recipient_name: [firstName, lastName].filter(Boolean).join(" ") || email,
                subject: "Welcome to LYMX — set up your account",
                body_text: "Hi " + (firstName || "there") + ",\n\nWelcome to LYMX! Your offer is accepted and your account is ready. "
                    + "Set your password and sign in here:\n\n" + actionUrl + "\n\nHR will follow up with your first-day onboarding checklist.\n\n— LYMX HR",
                template_key: "hire_welcome",
            }),
        });
        emailSent = resp.ok;
    } catch (e) { console.warn("[provision-hire] welcome email failed (non-fatal)", e); }

    return json({ ok: true, user_id: userId, created, email_sent: emailSent, provision: prov });
});
