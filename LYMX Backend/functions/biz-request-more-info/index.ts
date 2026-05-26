// =============================================================================
// LYMX Power — Request more info on a pending business application
// =============================================================================
// POST /functions/v1/biz-request-more-info
//
// Module 2 of the biz-onboarding roadmap. Used by an admin on
// admin-business-applications.html when a pending application is incomplete
// (missing license number, ambiguous category, an EIN that doesn't match the
// legal name, etc.) and the admin wants to ask the applicant to clarify
// BEFORE approving or rejecting. The application stays in `pending` status —
// only `request_more_info_at` + `requested_info_text` change.
//
// Side effects:
//   1. UPDATE businesses SET request_more_info_at = now(), requested_info_text = ...,
//                              requested_info_by = caller, ...
//   2. Send a styled Resend email to businesses.contact_email asking for the
//      requested info. The email is signed by the requesting admin (or "Kenny
//      @ LYMX" by default), reply-to kenny@lymxpower.com so replies come back
//      to the same inbox that handles approvals.
//   3. Log to email_sends with template_key='biz_request_more_info' and
//      business_id linked, so v_business_communications shows the request in
//      the timeline.
//
// REQUEST BODY:
//   { "business_id": "uuid", "requested_info_text": "..." }
//
// AUTH: caller must be admin (am_i_admin RPC returns true). Service-role
// callers also allowed for internal automation, but the admin UI is the
// expected caller.
//
// RESPONSE (200):
//   { "success": true, "business_id": "...", "sent_to": "...", "message_id": "..." }
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

function userFromJwt(authHeader: string | null): { id: string | null; isServiceRole: boolean } {
    if (!authHeader) return { id: null, isServiceRole: false };
    const tok = authHeader.replace(/^Bearer\s+/i, "").trim();
    const parts = tok.split(".");
    if (parts.length !== 3) return { id: null, isServiceRole: false };
    try {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        return { id: payload.sub || null, isServiceRole: payload.role === "service_role" };
    } catch {
        return { id: null, isServiceRole: false };
    }
}

function escHtml(s: string): string {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    } as Record<string, string>)[c]);
}

function moreInfoEmailTemplate(args: {
    business_name: string;
    owner_name: string | null;
    requested_info_text: string;
    admin_label: string;        // e.g. "Kenny @ LYMX" or "Helen @ LYMX"
    application_url: string;    // where they go to update the info if needed
}): { subject: string; html: string } {
    const greet = args.owner_name ? `Hi ${escHtml(args.owner_name)},` : "Hi,";
    const subject = `Quick follow-up on your LYMX application for ${args.business_name}`;
    // Preserve admin's line breaks. Bullet/quoted block so the question stands out.
    const questionHtml = escHtml(args.requested_info_text).replace(/\n/g, "<br>");

    const html = `<p>${greet}</p>

<p>Thanks for applying to bring <strong>${escHtml(args.business_name)}</strong> onto LYMX. Before I can approve your application, I need a bit more information from you:</p>

<blockquote style="margin:14px 0;padding:14px 18px;border-left:4px solid #0a84ff;background:#f0f7ff;border-radius:0 9px 9px 0;color:#0e1116;line-height:1.55">
${questionHtml}
</blockquote>

<p>Just reply to this email with the details — no form to fill out. Once I have what I need, your application moves straight to approval (typically within one business day).</p>

<p>If anything's unclear or you'd rather walk through it on the phone, reply with a good time and I'll set up a quick call.</p>

<p>— ${escHtml(args.admin_label)}<br>
<a href="mailto:kenny@lymxpower.com">kenny@lymxpower.com</a> · <a href="https://getlymx.com">getlymx.com</a></p>

<p style="color:#5b6472;font-size:12px;margin-top:24px">Your application reference: <a href="${args.application_url}">${args.application_url}</a></p>`;

    return { subject, html };
}

async function sendViaResend(
    to: string,
    subject: string,
    html: string,
    replyTo: string,
    apiKey: string,
): Promise<{ ok: boolean; error?: string; id?: string }> {
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
    if (!r.ok) return { ok: false, error: (body as any).message || `http ${r.status}` };
    return { ok: true, id: (body as any).id };
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
    const business_id         = (body.business_id || "").trim();
    const requested_info_text = (body.requested_info_text || "").toString().trim();
    if (!business_id)                       return errorResponse("business_id is required", 400);
    if (requested_info_text.length < 5)     return errorResponse("requested_info_text must be at least 5 characters", 400);
    if (requested_info_text.length > 4000)  return errorResponse("requested_info_text is too long (max 4000)", 400);

    // ─── Auth ───
    const authHeader = req.headers.get("authorization") || "";
    const { id: callerId, isServiceRole } = userFromJwt(authHeader);
    if (!callerId && !isServiceRole) return errorResponse("Authentication required", 401);

    const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // Admin gate (service_role bypasses)
    if (!isServiceRole) {
        const supaAsUser = createClient(SUPABASE_URL, SERVICE_KEY, {
            auth: { persistSession: false },
            global: { headers: { Authorization: authHeader } },
        });
        const { data: isAdmin, error: adminErr } = await supaAsUser.rpc("am_i_admin");
        if (adminErr) return errorResponse(`am_i_admin failed: ${adminErr.message}`, 500);
        if (!isAdmin) return errorResponse("Admin only", 403);
    }

    // ─── Load business ───
    const { data: biz, error: bizErr } = await supa
        .from("businesses")
        .select("id, slug, display_name, legal_name, contact_email, contact_phone, owner_user_id, approval_status")
        .eq("id", business_id)
        .maybeSingle();
    if (bizErr) return errorResponse(`businesses lookup failed: ${bizErr.message}`, 500);
    if (!biz)   return errorResponse("Business not found", 404);
    if (biz.approval_status !== "pending") {
        return errorResponse(`Cannot request more info on an application with status '${biz.approval_status}'. Move it back to pending first.`, 409);
    }

    const to = (biz.contact_email || "").trim();
    if (!to) return errorResponse("This business has no contact_email on file — cannot send the request", 400);

    // ─── Resolve owner name (best-effort, from biz_invitations OR profiles) ───
    let ownerName: string | null = null;
    try {
        const { data: inv } = await supa
            .from("biz_invitations")
            .select("prospect_owner_name")
            .eq("resulting_business_id", biz.id)
            .maybeSingle();
        if (inv && (inv as any).prospect_owner_name) ownerName = (inv as any).prospect_owner_name;
    } catch (e) {
        console.warn("[biz-request-more-info] invitation lookup failed (non-fatal)", e);
    }

    // ─── Resolve admin label (best-effort) ───
    let adminLabel = "Kenny @ LYMX";
    if (!isServiceRole && callerId) {
        try {
            const { data: u } = await supa.auth.admin.getUserById(callerId);
            const meta = (u as any)?.user?.user_metadata || {};
            const full = meta.full_name || meta.name;
            if (full) adminLabel = `${full} @ LYMX`;
        } catch (e) {
            console.warn("[biz-request-more-info] admin label lookup failed (non-fatal)", e);
        }
    }

    // ─── Send the email FIRST. If it fails we don't want to record a half-baked state. ───
    const tpl = moreInfoEmailTemplate({
        business_name: biz.display_name || biz.legal_name || "your business",
        owner_name: ownerName,
        requested_info_text,
        admin_label: adminLabel,
        application_url: `https://getlymx.com/admin-business-applications.html?biz=${biz.slug}`,
    });

    const send = await sendViaResend(to, tpl.subject, tpl.html, "kenny@lymxpower.com", RESEND_KEY);
    if (!send.ok) return errorResponse(`Resend failure: ${send.error}`, 502);

    // ─── Update businesses with the request state ───
    const { error: upErr } = await supa
        .from("businesses")
        .update({
            request_more_info_at: new Date().toISOString(),
            requested_info_text,
            requested_info_by: isServiceRole ? null : callerId,
            // Clear any prior response so the admin queue clearly shows the
            // applicant hasn't replied to THIS round.
            requested_info_response_at: null,
            requested_info_response_text: null,
        })
        .eq("id", biz.id);
    if (upErr) {
        // The email already went out; surface the DB error but flag that the
        // applicant has been emailed so the admin doesn't double-send.
        return json({
            success: false,
            email_sent_but_state_not_saved: true,
            sent_to: to,
            message_id: send.id,
            db_error: upErr.message,
        }, 500);
    }

    // ─── Record send in email_sends so the comms timeline shows it ───
    try {
        await supa.from("email_sends").insert({
            business_id: biz.id,
            template_key: "biz_request_more_info",
            to_address: to,
            from_address: "kenny@lymxpower.com",
            subject: tpl.subject,
            sender_user_id: isServiceRole ? null : callerId,
            send_status: "sent",
            sent_at: new Date().toISOString(),
            external_message_id: send.id,
        });
    } catch (e) {
        // Non-fatal — the email_sends log is for audit visibility, not the
        // critical path. The businesses table already carries the canonical
        // state.
        console.warn("[biz-request-more-info] email_sends insert failed (non-fatal)", e);
    }

    return json({
        success:    true,
        business_id: biz.id,
        sent_to:    to,
        subject:    tpl.subject,
        message_id: send.id,
    });
});
