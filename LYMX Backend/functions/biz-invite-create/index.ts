// =============================================================================
// LYMX Power — Create Business Invitation
// =============================================================================
// POST /functions/v1/biz-invite-create
//
// Creates a row in public.biz_invitations and returns the signed invite URL.
// Called by:
//   - admin-business-applications.html (admin "Invite a business" button)
//   - partner-crm.html                  (partner "+ Invite a business" button)
//
// Module 1 of the biz-onboarding roadmap (migration 093).
//
// REQUEST BODY:
//   {
//     "prospect_business_name": "Required",
//     "prospect_owner_name":    "Optional",
//     "prospect_contact_email": "Optional but recommended (for email send)",
//     "prospect_contact_phone": "Optional",
//     "assigned_partner_id":    "Optional UUID (only allowed for admins)",
//     "expires_in_days":        30,   // default 30, max 90
//     "notes":                  "Optional internal note",
//     "send_email":             true  // if true + email present, also POST to biz-invite-send-email
//   }
//
// AUTH: caller must be admin OR an authenticated partner. Anonymous calls
// are rejected.
//
// RESPONSE (200):
//   {
//     "success": true,
//     "invitation_id": "uuid",
//     "invite_url": "https://getlymx.com/biz-signup.html?invite_token=...",
//     "expires_at": "2026-06-25T03:14:00Z",
//     "email_dispatched": true | false
//   }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
const errorResponse = (message: string, status = 400) => json({ error: message }, status);

function userFromJwt(authHeader: string | null): string | null {
    if (!authHeader) return null;
    const tok = authHeader.replace(/^Bearer\s+/i, "").trim();
    const parts = tok.split(".");
    if (parts.length !== 3) return null;
    try {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        return payload.sub || null;
    } catch {
        return null;
    }
}

// URL-safe base64 random token. 32 bytes → ~43 chars after base64url.
function generateInvitationToken(): string {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    let b64 = btoa(String.fromCharCode(...buf));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function publicSiteBaseUrl(): string {
    // Override via env if Kenny ever spins up a staging origin.
    return Deno.env.get("LYMX_PUBLIC_SITE_URL") || "https://getlymx.com";
}

serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST")    return errorResponse("Method not allowed", 405);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!SUPABASE_URL || !SERVICE_KEY) {
        return errorResponse("Server misconfigured (missing SUPABASE_URL / SERVICE_KEY)", 500);
    }

    // ─── Auth: pull caller uid from JWT ───
    const callerId = userFromJwt(req.headers.get("authorization"));
    if (!callerId) return errorResponse("Authentication required", 401);

    // ─── Parse body ───
    let body: any;
    try {
        body = await req.json();
    } catch {
        return errorResponse("Invalid JSON body", 400);
    }

    const prospect_business_name = (body.prospect_business_name || "").trim();
    if (!prospect_business_name || prospect_business_name.length < 2) {
        return errorResponse("prospect_business_name is required (min 2 chars)", 400);
    }

    const prospect_owner_name    = (body.prospect_owner_name    || "").trim() || null;
    const prospect_contact_email = (body.prospect_contact_email || "").trim().toLowerCase() || null;
    const prospect_contact_phone = (body.prospect_contact_phone || "").trim() || null;
    const assigned_partner_id    = body.assigned_partner_id || null;
    const notes                  = (body.notes || "").trim() || null;
    const send_email             = body.send_email === true;

    const expiresInDays = Math.min(Math.max(Number(body.expires_in_days) || 30, 1), 90);
    const expiresAt     = new Date(Date.now() + expiresInDays * 86400 * 1000).toISOString();

    // ─── Resolve caller's role + their partners.id (if any) for attribution
    const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // Admin check via canonical RPC
    const { data: adminFlag, error: adminErr } = await supa.rpc("am_i_admin");
    // am_i_admin reads auth.uid() from the JWT; since we're using service_role
    // we need to call it with the user's bearer token instead. Build a second
    // client bound to the caller JWT for permission checks:
    const userJwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const supaAsUser = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${userJwt}` } },
    });
    const { data: isAdminFromJwt } = await supaAsUser.rpc("am_i_admin");
    const isAdmin = !!isAdminFromJwt;

    // Resolve caller's partner row (if they have one)
    const { data: callerPartner } = await supa
        .from("partners")
        .select("id, display_name")
        .eq("user_id", callerId)
        .maybeSingle();

    // ─── Permission gates ───
    if (!isAdmin && !callerPartner) {
        return errorResponse("Only admins and partners can create invitations", 403);
    }

    let resolvedAssignedPartnerId: string | null = null;
    if (isAdmin) {
        // Admin can pin to any partner OR leave unassigned.
        resolvedAssignedPartnerId = assigned_partner_id || null;
        if (resolvedAssignedPartnerId) {
            const { data: partnerExists } = await supa
                .from("partners")
                .select("id")
                .eq("id", resolvedAssignedPartnerId)
                .maybeSingle();
            if (!partnerExists) {
                return errorResponse("assigned_partner_id does not match a known partner", 400);
            }
        }
    } else {
        // Non-admin: must be a partner; assigned_partner_id is locked to themselves.
        if (assigned_partner_id && assigned_partner_id !== callerPartner!.id) {
            return errorResponse("Partners can only assign invites to themselves", 403);
        }
        resolvedAssignedPartnerId = callerPartner!.id;
    }

    // ─── Generate token (loop a few times if we hit the UNIQUE collision) ───
    let invitation_token = "";
    let inserted: any = null;
    for (let attempt = 0; attempt < 5; attempt++) {
        invitation_token = generateInvitationToken();
        const { data, error } = await supa
            .from("biz_invitations")
            .insert({
                invitation_token,
                prospect_business_name,
                prospect_owner_name,
                prospect_contact_email,
                prospect_contact_phone,
                invited_by_user_id:  callerId,
                assigned_partner_id: resolvedAssignedPartnerId,
                expires_at:          expiresAt,
                notes,
                status:              "pending",
            })
            .select("id, invitation_token, expires_at")
            .single();
        if (!error) { inserted = data; break; }
        // Token collision is the only retryable error
        const code = (error as any).code;
        if (code !== "23505") {
            console.error("[biz-invite-create] insert failed", error);
            return errorResponse(`Insert failed: ${error.message}`, 500);
        }
    }
    if (!inserted) {
        return errorResponse("Failed to generate unique invitation token after 5 tries", 500);
    }

    // 2026-05-27 #05 / 2026-05-31 #efde04e2 — append the assigned partner's
    // REFERRAL CODE (P-000xxx) as ?ref so when the prospect opens the link,
    // biz-signup.html auto-fills the "Partner referral code" field and the
    // signup is attributed back to the sender. ROOT CAUSE of #efde04e2: the
    // previous version appended the partners.id UUID, but biz-signup.html fills
    // the referral field verbatim (it does NOT resolve UUID->code) and
    // attribution matches on the human code — so a UUID never populated/credited.
    // Resolve the code here (fall back to the UUID only if the code is missing).
    let refValue = "";
    if (resolvedAssignedPartnerId) {
        const { data: refPartner } = await supabase
            .from("partners")
            .select("partner_code")
            .eq("id", resolvedAssignedPartnerId)
            .maybeSingle();
        refValue = (refPartner && refPartner.partner_code) ? refPartner.partner_code : resolvedAssignedPartnerId;
    }
    const refSuffix = refValue ? `&ref=${encodeURIComponent(refValue)}` : "";
    const inviteUrl = `${publicSiteBaseUrl()}/biz-signup.html?invite_token=${invitation_token}${refSuffix}`;

    // ─── Optionally dispatch email ───
    let email_dispatched = false;
    let email_error: string | null = null;
    if (send_email && prospect_contact_email) {
        try {
            const sendUrl = `${SUPABASE_URL}/functions/v1/biz-invite-send-email`;
            const resp = await fetch(sendUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${SERVICE_KEY}`,
                    apikey: SERVICE_KEY,
                },
                body: JSON.stringify({
                    invitation_id: inserted.id,
                }),
            });
            email_dispatched = resp.ok;
            if (!resp.ok) {
                email_error = (await resp.text()).slice(0, 300);
                console.warn("[biz-invite-create] email dispatch failed", email_error);
            }
        } catch (e) {
            email_error = (e as Error).message;
            console.warn("[biz-invite-create] email dispatch threw", e);
        }
    }

    return json({
        success:          true,
        invitation_id:    inserted.id,
        invite_url:       inviteUrl,
        expires_at:       inserted.expires_at,
        email_dispatched,
        email_error,
    });
});
