// =============================================================================
// LYMX Power — Send Business Invitation Email
// =============================================================================
// POST /functions/v1/biz-invite-send-email
//
// Sends the invitation email via Resend for a previously-created row in
// public.biz_invitations. Called either:
//   (a) directly by biz-invite-create when `send_email: true` was passed, OR
//   (b) by admin / partner UI's "Resend invite" button (when a prospect didn't
//       click the first time within ~7 days).
//
// REQUEST BODY:
//   { "invitation_id": "uuid" }       — required
//   { "override_to": "x@y.com" }      — optional, admin-only; overrides the
//                                       row's prospect_contact_email
//
// AUTH: caller must be admin OR the partner who owns the invitation OR
// service_role (when called internally by biz-invite-create).
//
// RESPONSE (200):
//   { "success": true, "sent_to": "...", "subject": "...", "message_id": "..." }
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

function publicSiteBaseUrl(): string {
    return Deno.env.get("LYMX_PUBLIC_SITE_URL") || "https://getlymx.com";
}

function inviteEmailTemplate(args: {
    business_name: string;
    owner_name: string | null;
    invite_url: string;
    inviter_label: string;        // e.g. "Kenny @ LYMX" or "Lisa (LYMX Partner)"
    expires_at: string;           // ISO
}): { subject: string; html: string } {
    const greet = args.owner_name ? `Hi ${args.owner_name},` : "Hi,";
    const expiresHuman = new Date(args.expires_at).toLocaleDateString("en-US", {
        month: "long", day: "numeric", year: "numeric",
    });

    const subject = `${args.business_name} on LYMX — your invite from ${args.inviter_label}`;
    const html = `<p>${greet}</p>

<p>${args.inviter_label} would like to bring <strong>${args.business_name}</strong> onto the LYMX rewards network. This invite link gets you started:</p>

<p><a href="${args.invite_url}" style="display:inline-block;background:#0a84ff;color:#ffffff;padding:13px 24px;border-radius:9px;font-weight:700;text-decoration:none">Set up ${args.business_name} on LYMX →</a></p>

<p style="color:#5b6472;font-size:13.5px">Or paste this link into your browser:<br>
<a href="${args.invite_url}">${args.invite_url}</a></p>

<h3 style="margin-top:24px;font-size:16px">What happens next</h3>

<ol style="padding-left:20px;color:#1a1f27;line-height:1.6">
  <li><strong>Sign up</strong> — a short form (storefront or self-employed). Most businesses finish in under 5 minutes.</li>
  <li><strong>Admin approval</strong> — Kenny reviews each application personally, typically within one business day.</li>
  <li><strong>Live walkthrough</strong> — a required 20-minute call with our onboarding specialist Rachel. She'll wire up your dashboard, answer questions, and make sure your first reward issuance works.</li>
  <li><strong>You're live</strong> — customers start earning LYMX on your transactions.</li>
</ol>

<p style="color:#5b6472;font-size:13.5px;margin-top:24px">This invite expires on <strong>${expiresHuman}</strong>.</p>

<p style="color:#5b6472;font-size:13.5px">Questions? Reply directly to this email — it reaches Kenny.</p>

<p>— LYMX Power Inc.<br>
<a href="mailto:hello@getlymx.com">hello@getlymx.com</a> · <a href="https://getlymx.com">getlymx.com</a></p>`;

    return { subject, html };
}

async function sendViaResend(to: string, subject: string, html: string, replyTo: string, apiKey: string)
    : Promise<{ ok: boolean; error?: string; id?: string }>
{
    const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            from: "LYMX <kenny@lymxpower.com>",
            to: [to],
            subject,
            html,
            reply_to: replyTo,
        }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: body.message || `http ${r.status}` };
    return { ok: true, id: body.id };
}

serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST")    return errorResponse("Method not allowed", 405);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const RESEND_KEY   = Deno.env.get("RESEND_API_KEY");
    if (!SUPABASE_URL || !SERVICE_KEY) return errorResponse("Server config missing", 500);
    if (!RESEND_KEY)                   return errorResponse("RESEND_API_KEY not configured", 500);

    // ─── Parse body ───
    let body: any;
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON body", 400); }
    const invitation_id = body.invitation_id;
    const override_to   = (body.override_to || "").trim().toLowerCase() || null;
    if (!invitation_id) return errorResponse("invitation_id is required", 400);

    // ─── Auth: caller can be admin, owning partner, or service_role ───
    const authHeader = req.headers.get("authorization") || "";
    const callerId = userFromJwt(authHeader);

    // Detect service-role caller: the JWT's role claim is "service_role".
    let isServiceRole = false;
    try {
        const tok = authHeader.replace(/^Bearer\s+/i, "").trim();
        const parts = tok.split(".");
        if (parts.length === 3) {
            const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
            isServiceRole = payload.role === "service_role";
        }
    } catch { /* fall through; treated as not service role */ }

    if (!callerId && !isServiceRole) return errorResponse("Authentication required", 401);

    const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // ─── Load the invitation row + inviter context ───
    const { data: inv, error: invErr } = await supa
        .from("biz_invitations")
        .select(`
            id, invitation_token, prospect_business_name, prospect_owner_name,
            prospect_contact_email, expires_at, status,
            invited_by_user_id, assigned_partner_id
        `)
        .eq("id", invitation_id)
        .maybeSingle();
    if (invErr || !inv) return errorResponse("Invitation not found", 404);
    if (inv.status === "revoked")  return errorResponse("Invitation is revoked", 409);
    if (inv.status === "signed_up") return errorResponse("Invitation already used", 409);

    // ─── Permission gate (when not service_role) ───
    if (!isServiceRole) {
        // Admin?
        const supaAsUser = createClient(SUPABASE_URL, SERVICE_KEY, {
            auth: { persistSession: false },
            global: { headers: { Authorization: authHeader } },
        });
        const { data: isAdmin } = await supaAsUser.rpc("am_i_admin");

        let allowed = !!isAdmin;
        if (!allowed && inv.invited_by_user_id === callerId) allowed = true;
        if (!allowed && inv.assigned_partner_id) {
            const { data: p } = await supa
                .from("partners")
                .select("id")
                .eq("id", inv.assigned_partner_id)
                .eq("user_id", callerId)
                .maybeSingle();
            if (p) allowed = true;
        }
        if (!allowed) return errorResponse("Not authorized to send this invitation", 403);

        // override_to is admin-only (defense against partner spoofing)
        if (override_to && !isAdmin) {
            return errorResponse("Only admins may override the recipient email", 403);
        }
    }

    const to = override_to || inv.prospect_contact_email;
    if (!to) return errorResponse("No recipient email on file and no override_to provided", 400);

    // ─── Resolve inviter label ("Kenny @ LYMX" or "Lisa (LYMX Partner)") ───
    let inviter_label = "the LYMX team";
    if (inv.assigned_partner_id) {
        const { data: p } = await supa
            .from("partners")
            .select("display_name")
            .eq("id", inv.assigned_partner_id)
            .maybeSingle();
        if (p?.display_name) inviter_label = `${p.display_name} (LYMX Partner)`;
    } else if (inv.invited_by_user_id) {
        // Pull from auth.users.user_metadata.full_name when available
        const { data: u } = await supa
            .from("auth.users" as any)  // not directly accessible — fall back below
            .select("id");
        // Simpler fallback: use a sensible default
        inviter_label = "Kenny @ LYMX";
    }

    const invite_url = `${publicSiteBaseUrl()}/biz-signup.html?invite_token=${inv.invitation_token}`;
    const tpl = inviteEmailTemplate({
        business_name: inv.prospect_business_name,
        owner_name:    inv.prospect_owner_name,
        invite_url,
        inviter_label,
        expires_at:    inv.expires_at,
    });

    const send = await sendViaResend(to, tpl.subject, tpl.html, "kenny@lymxpower.com", RESEND_KEY);
    if (!send.ok) return errorResponse(`Resend failure: ${send.error}`, 502);

    // ─── Record the send so the admin UI can show "last emailed" ───
    await supa
        .from("biz_invitations")
        .update({
            notes: (inv as any).notes
                ? `${(inv as any).notes}\n[sent ${new Date().toISOString()} to ${to}, msg ${send.id}]`
                : `[sent ${new Date().toISOString()} to ${to}, msg ${send.id}]`,
        })
        .eq("id", inv.id);

    return json({
        success:    true,
        sent_to:    to,
        subject:    tpl.subject,
        message_id: send.id,
    });
});
