// =============================================================================
// LYMX Power — Partner Email Revoke (Offboarding) Endpoint
// =============================================================================
// POST /functions/v1/partner-revoke-email
//
// Companion to partner-provision-email. Called when a partner offboards
// (status flipped to inactive in `partners`, fee waiver expired and unpaid,
// etc.) — disables their @getlymx.com email.
//
// PIPELINE:
//   1. Look up partner_emails row by partner_id
//   2. If already suspended → return success no-op
//   3. Delete the Cloudflare Email Routing rule using saved cloudflare_route_id
//      (so inbound mail to that address bounces immediately)
//   4. Flip the row to status='suspended', stamp suspended_at = now()
//
// WHAT WE DO NOT DO:
//   - Delete the SES domain identity — it's shared across all partners.
//   - Rotate SES SMTP credentials — also shared. The partner's Gmail
//     "Send mail as" config still has them; we'd need to wait for them to
//     hit a real send to discover SES rejects them. That's acceptable: we'd
//     need an account-wide rotation for true revocation, which is a v2 task.
//   - DELETE the partner_emails row — kept for audit. Future-Kenny can see
//     which addresses were ever provisioned + when they were suspended.
//   - Notify the partner — sending a "your work email has been disabled"
//     message is a separate flow that should be triggered upstream
//     (whichever endpoint flips partners.archived_at).
//
// IDEMPOTENT: re-running for an already-suspended partner is a no-op.
//   If Cloudflare deletion fails (route was deleted out-of-band, etc.), we
//   still flip status to suspended and stamp last_error so a human can
//   investigate. Better to have an inconsistent state we know about than
//   to leave the partner with a working work-email after offboarding.
//
// AUTH: service_role ONLY (same JWT role-claim decode pattern as the rest of
//   the partner-email pipeline).
//
// REQUEST BODY (JSON):
// {
//   "partner_id": "uuid"
// }
//
// RESPONSE (200):
// {
//   "success":          true,
//   "partner_email_id": "uuid",
//   "full_email":       "maya.chen@getlymx.com",
//   "status":           "suspended",
//   "cloudflare_route_deleted": true
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

interface RevokeBody {
    partner_id: string;
}

// =============================================================================
// Helpers
// =============================================================================

/** Decode JWT role claim — gateway re-stamps header so literal compare fails */
function getJwtRole(jwt: string): string | null {
    try {
        const parts = jwt.split(".");
        if (parts.length !== 3) return null;
        const payload = JSON.parse(
            atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
        );
        return payload.role ?? null;
    } catch {
        return null;
    }
}

/**
 * Delete a Cloudflare Email Routing rule by ID.
 * Returns true on success, false if the rule was already gone, throws on other errors.
 */
async function deleteCloudflareRoute(args: {
    zoneId: string;
    apiToken: string;
    routeId: string;
}): Promise<boolean> {
    const url = `https://api.cloudflare.com/client/v4/zones/${args.zoneId}/email/routing/rules/${args.routeId}`;
    const resp = await fetch(url, {
        method: "DELETE",
        headers: {
            "Authorization": `Bearer ${args.apiToken}`,
        },
    });

    // 404 = route already gone — treat as success (idempotency).
    if (resp.status === 404) return false;

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || (json && json.success === false)) {
        const errs = json?.errors?.map((e: { message: string }) => e.message).join("; ") ?? resp.statusText;
        throw new Error(`Cloudflare DELETE ${resp.status}: ${errs}`);
    }
    return true;
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

    // ---- Auth: service_role only --------------------------------------------
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
        return errorResponse("Missing Authorization header", 401);
    }
    const token = authHeader.replace("Bearer ", "");
    // 2026-05-21 #d516e0bf — accept BOTH the legacy JWT-format service-role token
    // (role claim = "service_role") AND the new sb_secret_* opaque format (direct
    // match against SUPABASE_SERVICE_ROLE_KEY). Pre-fix, only the JWT path worked, so
    // every internal call from partner-upgrade silently 403'd and partner_emails
    // never got inserted. See feedback_supabase_new_key_format_jwt.md memo.
    const _serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const _isLegacyJwt = getJwtRole(token) === "service_role";
    const _isNewSecret = !!token && token === _serviceKey;
    if (!_isLegacyJwt && !_isNewSecret) {
        return errorResponse(
            "Forbidden: partner-revoke-email is service-role only",
            403
        );
    }

    // ---- Body ----------------------------------------------------------------
    let body: RevokeBody;
    try {
        body = await req.json();
    } catch {
        return errorResponse("Invalid JSON", 400);
    }
    if (!body.partner_id || typeof body.partner_id !== "string") {
        return errorResponse("partner_id (uuid) is required", 400);
    }

    // ---- Env var sanity ------------------------------------------------------
    const env = (k: string) => Deno.env.get(k);
    const required = [
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "CF_ZONE_ID_LYMX",
        "CF_API_TOKEN_LYMX",
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

    // =========================================================================
    // STEP 1: Look up the partner_emails row
    // =========================================================================
    const { data: row, error: lookupErr } = await supabase
        .from("partner_emails")
        .select("id, full_email, status, cloudflare_route_id, suspended_at")
        .eq("partner_id", body.partner_id)
        .maybeSingle();
    if (lookupErr) {
        return errorResponse(`partner_emails lookup failed: ${lookupErr.message}`, 500);
    }
    if (!row) {
        return errorResponse(
            `No partner_emails row for partner ${body.partner_id} — nothing to revoke`,
            404
        );
    }

    // =========================================================================
    // STEP 2: Idempotency — already suspended? Return no-op.
    // =========================================================================
    if (row.status === "suspended") {
        return jsonResponse({
            success: true,
            partner_email_id: row.id,
            full_email: row.full_email,
            status: "suspended",
            cloudflare_route_deleted: false,
            note: "Already suspended — no-op",
        });
    }

    // =========================================================================
    // STEP 3: Delete the Cloudflare route (best-effort; we suspend either way)
    // =========================================================================
    let cloudflareDeleted = false;
    let cloudflareError: string | null = null;
    if (row.cloudflare_route_id) {
        try {
            cloudflareDeleted = await deleteCloudflareRoute({
                zoneId: env("CF_ZONE_ID_LYMX")!,
                apiToken: env("CF_API_TOKEN_LYMX")!,
                routeId: row.cloudflare_route_id,
            });
        } catch (e) {
            cloudflareError = e instanceof Error ? e.message : String(e);
            // We log it but DO NOT abort. Better to mark suspended in our DB
            // even if the route deletion failed — a human can clean up later.
            console.error(`[partner-revoke-email] CF delete failed for ${row.id}:`, cloudflareError);
        }
    } else {
        // No route_id stored — provisioning may have failed before reaching CF,
        // or this row predates the route_id column. Nothing to delete.
        cloudflareError = "No cloudflare_route_id on row; nothing to delete (acceptable)";
    }

    // =========================================================================
    // STEP 4: Flip row to suspended
    // =========================================================================
    const update: Record<string, unknown> = {
        status: "suspended",
        suspended_at: new Date().toISOString(),
    };
    if (cloudflareError) update.last_error = cloudflareError;
    else update.last_error = null;

    const { error: updateErr } = await supabase
        .from("partner_emails")
        .update(update)
        .eq("id", row.id);
    if (updateErr) {
        return errorResponse(
            `partner_emails update failed: ${updateErr.message}` +
                (cloudflareError ? ` (also: ${cloudflareError})` : ""),
            500
        );
    }

    return jsonResponse({
        success: true,
        partner_email_id: row.id,
        full_email: row.full_email,
        status: "suspended",
        cloudflare_route_deleted: cloudflareDeleted,
        ...(cloudflareError ? { warning: cloudflareError } : {}),
    });
});
