// =============================================================================
// LYMX Power — Partner Email Provisioning Endpoint
// =============================================================================
// POST /functions/v1/partner-provision-email
//
// Provisions a branded `firstname.lastname@getlymx.com` work email for a
// new partner. Invoked from the partner-signup flow after the partner row
// is created. Idempotent: re-running for the same partner_id is a no-op
// once they're 'active' (UNIQUE on partner_id + status check).
//
// PIPELINE:
//   1. Fetch partner row (legal_name, contact_email, is_founding_25)
//   2. Generate local-part: firstname.lastname (with .2/.3 collision suffix)
//   3. INSERT partner_emails row (status='pending')
//   4. UPDATE to status='provisioning'
//   5. Call Cloudflare Email Routing API to add the forwarding rule
//   6. UPDATE row with cloudflare_route_id + SMTP creds (from env) + status='active'
//   7. Render onboarding email (partner-welcome.ts) and POST to Resend
//   8. UPDATE row: onboarding_email_sent_at = now()
//   9. Return {success, partner_email_id, full_email}
//
// AUTH: service_role ONLY. This is an internal function called from
//   partner-signup. Uses the JWT role-claim decode pattern (per the lesson
//   learned with the settlement endpoint — Supabase's gateway re-stamps the
//   Authorization header so a literal token compare is unreliable).
//
// DOMAIN VERIFICATION ASSUMPTION:
//   This function assumes `getlymx.com` is verified in SES at the DOMAIN
//   level (one-time setup per COMPANY-EMAIL-ARCHITECTURE.md §2.2). With
//   domain-level verification, a single shared SES SMTP credential pair is
//   sufficient for ALL `*@getlymx.com` addresses — we don't need to call
//   SES.CreateEmailIdentity per partner. The SMTP creds live in env vars
//   (SES_SMTP_USERNAME, SES_SMTP_PASSWORD) and we copy them into the
//   partner_emails row at provision time so we have an audit trail of who
//   received which credentials version.
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
//   "status":           "active"
// }
//
// ENV VARS REQUIRED (set on Supabase Edge Functions secrets):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   CF_ZONE_ID_LYMX           — Cloudflare zone ID for getlymx.com
//   CF_API_TOKEN_LYMX         — Cloudflare API token (Email Routing Rules + Zone DNS)
//   SES_REGION                — e.g. "us-east-1"
//   SES_SMTP_USERNAME         — derived from IAM access key (per AWS docs)
//   SES_SMTP_PASSWORD         — derived from IAM secret + region (per AWS docs)
//   RESEND_API_KEY            — for sending the onboarding email
//   EMAIL_FROM                — e.g. "LYMX <hello@getlymx.com>"
//   LYMX_DOMAIN               — defaults to "getlymx.com"
//   LYMX_SITE_URL             — defaults to "https://getlymx.com"
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { partnerWelcomeEmail } from "./partner-welcome.ts";

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

interface ProvisionBody {
    partner_id: string;
}

// =============================================================================
// Helpers
// =============================================================================

/** Decode JWT role claim — settlement endpoint lesson, gateway re-stamps header */
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

/** Slugify a name into local-part safe characters */
function nameToLocalPart(legalName: string): string {
    return legalName
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")   // strip combining diacritical marks
        .replace(/[^a-z0-9\s]/g, "")       // strip punctuation
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .join(".");
}

/**
 * Find a non-conflicting local_part by querying partner_emails.
 * If "maya.chen" is taken, try "maya.chen.2", "maya.chen.3", ...
 */
async function findFreeLocalPart(
    supabase: ReturnType<typeof createClient>,
    base: string
): Promise<string> {
    let candidate = base;
    let suffix = 2;

    // Cap at 100 attempts so we don't loop forever on something pathological.
    for (let i = 0; i < 100; i++) {
        const { data, error } = await supabase
            .from("partner_emails")
            .select("id")
            .eq("local_part", candidate)
            .maybeSingle();
        if (error) throw new Error(`local-part lookup failed: ${error.message}`);
        if (!data) return candidate;
        candidate = `${base}.${suffix}`;
        suffix++;
    }
    throw new Error(`No free local_part found near "${base}" after 100 tries`);
}

/**
 * Add a Cloudflare Email Routing rule that forwards `fullEmail` → `forwardTo`.
 * Returns the route id (which we save so we can DELETE on offboarding).
 */
async function createCloudflareRoute(args: {
    zoneId: string;
    apiToken: string;
    fullEmail: string;
    forwardTo: string;
    name: string;
}): Promise<string> {
    const url = `https://api.cloudflare.com/client/v4/zones/${args.zoneId}/email/routing/rules`;
    const body = {
        name: args.name,
        enabled: true,
        matchers: [
            { type: "literal", field: "to", value: args.fullEmail },
        ],
        actions: [
            { type: "forward", value: [args.forwardTo] },
        ],
    };
    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${args.apiToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    const json = await resp.json();
    if (!resp.ok || !json.success) {
        const errs = json.errors?.map((e: { message: string }) => e.message).join("; ") ?? resp.statusText;
        throw new Error(`Cloudflare API ${resp.status}: ${errs}`);
    }
    if (!json.result?.id) {
        throw new Error("Cloudflare API returned success but no route id");
    }
    return json.result.id as string;
}

/**
 * Send an email via Resend.
 * Returns the message id on success or throws on failure.
 */
async function sendViaResend(args: {
    apiKey: string;
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
}): Promise<string> {
    const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${args.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            from: args.from,
            to: args.to,
            subject: args.subject,
            html: args.html,
            text: args.text,
        }),
    });
    const json = await resp.json();
    if (!resp.ok) {
        throw new Error(`Resend ${resp.status}: ${json.message ?? json.error ?? "unknown"}`);
    }
    return (json.id as string) ?? "";
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
            "Forbidden: partner-provision-email is service-role only",
            403
        );
    }

    // ---- Body ----------------------------------------------------------------
    let body: ProvisionBody;
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
        "SES_SMTP_USERNAME",
        "SES_SMTP_PASSWORD",
        "RESEND_API_KEY",
    ];
    const missing = required.filter((k) => !env(k));
    if (missing.length > 0) {
        return errorResponse(
            `Server misconfigured — missing env vars: ${missing.join(", ")}`,
            500
        );
    }

    const lymxDomain = env("LYMX_DOMAIN") ?? "getlymx.com";
    const siteUrl = env("LYMX_SITE_URL") ?? "https://getlymx.com";
    const sesRegion = env("SES_REGION") ?? "us-east-1";
    const smtpHost = `email-smtp.${sesRegion}.amazonaws.com`;
    const fromAddress = env("EMAIL_FROM") ?? "LYMX <hello@getlymx.com>";

    const supabase = createClient(
        env("SUPABASE_URL")!,
        env("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } }
    );

    // =========================================================================
    // STEP 1: Fetch the partner
    // =========================================================================
    const { data: partner, error: pErr } = await supabase
        .from("partners")
        .select("id, legal_name, display_name, contact_email, is_founding_25, archived_at")
        .eq("id", body.partner_id)
        .maybeSingle();
    if (pErr) {
        return errorResponse(`Partner lookup failed: ${pErr.message}`, 500);
    }
    if (!partner) {
        return errorResponse(`Partner ${body.partner_id} not found`, 404);
    }
    if (partner.archived_at) {
        return errorResponse("Partner is archived; refusing to provision", 400);
    }

    // =========================================================================
    // STEP 2: Idempotency — if there's already an active row for this partner,
    //         return it. If a previous attempt left it pending/provisioning,
    //         we'll resume by going through the steps again.
    // =========================================================================
    const { data: existing } = await supabase
        .from("partner_emails")
        .select("id, full_email, status")
        .eq("partner_id", partner.id)
        .maybeSingle();
    if (existing && existing.status === "active") {
        return jsonResponse({
            success: true,
            partner_email_id: existing.id,
            full_email: existing.full_email,
            status: "active",
            note: "Already provisioned — no-op",
        });
    }

    // =========================================================================
    // STEP 3: Pick a local-part, claim it by INSERTing the row
    // =========================================================================
    const baseLocal = nameToLocalPart(partner.legal_name);
    if (!baseLocal) {
        return errorResponse(
            `Cannot derive local-part from legal_name "${partner.legal_name}"`,
            400
        );
    }

    let row: { id: string; full_email: string; local_part: string };

    if (existing) {
        // Resume the prior incomplete row; reuse its local_part.
        row = {
            id: existing.id,
            full_email: existing.full_email,
            local_part: existing.full_email.split("@")[0],
        };
    } else {
        const localPart = await findFreeLocalPart(supabase, baseLocal);
        const fullEmail = `${localPart}@${lymxDomain}`;

        const { data: inserted, error: iErr } = await supabase
            .from("partner_emails")
            .insert({
                partner_id: partner.id,
                local_part: localPart,
                full_email: fullEmail,
                forward_to: partner.contact_email,
                display_name: partner.display_name ?? partner.legal_name,
                status: "pending",
            })
            .select("id, full_email, local_part")
            .single();
        if (iErr || !inserted) {
            return errorResponse(`partner_emails insert failed: ${iErr?.message}`, 500);
        }
        row = inserted;
    }

    // Helper: stamp last_error + status on failure paths so we can retry.
    const fail = async (status: number, message: string) => {
        await supabase
            .from("partner_emails")
            .update({ last_error: message, status: "pending" })
            .eq("id", row.id);
        return errorResponse(message, status);
    };

    // Move to provisioning state.
    await supabase
        .from("partner_emails")
        .update({ status: "provisioning", last_error: null })
        .eq("id", row.id);

    // =========================================================================
    // STEP 4: Cloudflare — create the forwarding route
    // =========================================================================
    let cloudflareRouteId: string;
    try {
        cloudflareRouteId = await createCloudflareRoute({
            zoneId: env("CF_ZONE_ID_LYMX")!,
            apiToken: env("CF_API_TOKEN_LYMX")!,
            fullEmail: row.full_email,
            forwardTo: partner.contact_email,
            name: `Forward ${row.local_part} (partner ${partner.id.slice(0, 8)})`,
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return await fail(502, `Cloudflare route create failed: ${msg}`);
    }

    // =========================================================================
    // STEP 5: Mark active + copy in SMTP creds
    // =========================================================================
    const smtpUsername = env("SES_SMTP_USERNAME")!;
    const smtpPassword = env("SES_SMTP_PASSWORD")!;

    const { error: uErr } = await supabase
        .from("partner_emails")
        .update({
            cloudflare_route_id: cloudflareRouteId,
            ses_identity_verified: true,    // domain-level verification covers all *@getlymx.com
            smtp_username: smtpUsername,
            smtp_password: smtpPassword,
            status: "active",
            provisioned_at: new Date().toISOString(),
        })
        .eq("id", row.id);
    if (uErr) {
        return await fail(500, `partner_emails update failed: ${uErr.message}`);
    }

    // =========================================================================
    // STEP 6: Render + send the onboarding email via Resend
    // =========================================================================
    // We want a unique referral code for the partner. The partner row may not
    // have one yet (depending on signup-flow design). For now, use a slug
    // derived from local_part — the proper signup flow can replace this with
    // a real referral_code lookup.
    const referralCode = (partner.display_name ?? partner.legal_name)
        .replace(/[^a-zA-Z]/g, "")
        .toUpperCase()
        .slice(0, 8) || "PARTNER";

    const { subject, html, text } = partnerWelcomeEmail({
        fullName: partner.display_name ?? partner.legal_name,
        referralCode,
        siteUrl,
        companyEmail: row.full_email,
        smtpHost,
        smtpUsername,
        smtpPassword,
        foundingTwentyFive: partner.is_founding_25 === true,
    });

    try {
        await sendViaResend({
            apiKey: env("RESEND_API_KEY")!,
            from: fromAddress,
            to: partner.contact_email,
            subject,
            html,
            text,
        });
    } catch (e) {
        // Email send failed but provisioning succeeded. Don't fail the request —
        // a reconciliation job can retry the email. Mark the row so we can find it.
        const msg = e instanceof Error ? e.message : String(e);
        await supabase
            .from("partner_emails")
            .update({ last_error: `Onboarding email failed: ${msg}` })
            .eq("id", row.id);
        return jsonResponse({
            success: true,
            partner_email_id: row.id,
            full_email: row.full_email,
            status: "active",
            warning: `Email send failed: ${msg}. Provisioning is complete; retry email separately.`,
        });
    }

    await supabase
        .from("partner_emails")
        .update({ onboarding_email_sent_at: new Date().toISOString() })
        .eq("id", row.id);

    return jsonResponse({
        success: true,
        partner_email_id: row.id,
        full_email: row.full_email,
        status: "active",
    });
});
