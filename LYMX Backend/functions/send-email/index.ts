// =============================================================================
// LYMX Power — Send Email (1:1 compose, mirrors InvestPro's send-marketing-email)
// =============================================================================
// POST /functions/v1/send-email
//
// Single-recipient email from a staff/admin member's LYMX work alias. Used by
// admin-compose-email.html. Sends via Resend, logs to public.email_sends so
// it shows up in the sender's "recent sends" + lands in email_events when
// Resend webhooks back.
//
// REQUEST BODY:
//   {
//     channel: "outreach" | "transactional",
//     recipient_email: string,
//     recipient_name?: string | null,
//     subject: string,
//     body_text: string,
//     body_html?: string,
//     template_key?: string
//   }
//
// CHANNELS:
//   outreach      → <local>@lymxpower.com   (marketing/promo)
//   transactional → <local>@getlymx.com     (customer-facing reply/follow-up)
//
// AUTH: any authenticated user (sender must have an active partner_emails alias
// — if none, falls back to their auth.email's local-part).
//
// RESPONSE (200):
//   { ok: true, send_id, from, to, resend_message_id }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const err = (m: string, s = 400) => json({ ok: false, error: m }, s);

const CHANNEL_DOMAINS: Record<string, string> = {
    outreach:      "lymxpower.com",
    transactional: "getlymx.com",
};

// Escape HTML for safe rendering
function escHtml(s: string): string {
    return String(s == null ? "" : s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;" }[c] as string));
}

// Convert plain text to safe HTML (line breaks + autolink getlymx.com / lymxpower.com URLs)
function textToHtml(text: string): string {
    let html = escHtml(text);
    // Autolink urls
    html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    // Convert newlines to <br>
    html = html.replace(/\n/g, "<br>");
    return "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#0e1116\">" + html + "</div>";
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return err("Method not allowed", 405);

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
    if (!SB_URL || !SB_KEY) return err("Server config missing", 500);
    if (!RESEND_KEY) return err("RESEND_API_KEY not configured", 500);

    const supabase = createClient(SB_URL, SB_KEY);

    // Auth
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return err("Unauthorized", 401);
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return err("Invalid token", 401);

    const senderId = userData.user.id;
    const senderEmail = userData.user.email;

    // Body
    let body: any;
    try { body = await req.json(); } catch { return err("Invalid JSON", 400); }
    const { channel, recipient_email, recipient_name, subject, body_text, body_html, template_key } = body || {};
    if (!channel || !CHANNEL_DOMAINS[channel]) return err("Bad channel — must be 'outreach' or 'transactional'", 400);
    if (!recipient_email || !subject || !body_text) return err("recipient_email, subject, body_text are required", 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient_email)) return err("recipient_email is not a valid email", 400);

    // Resolve sender's local-part
    let localPart = "";
    const { data: aliasRow } = await supabase
        .from("partner_emails")
        .select("local_part")
        .eq("forward_to", senderEmail)
        .eq("status", "active")
        .maybeSingle();
    if (aliasRow?.local_part) {
        localPart = aliasRow.local_part;
    } else if (senderEmail) {
        // Fallback: use the local-part of their auth email
        localPart = senderEmail.split("@")[0].toLowerCase();
    } else {
        return err("Could not determine your sender alias — make sure your LYMX email is provisioned", 422);
    }

    const fromAddress = `${localPart}@${CHANNEL_DOMAINS[channel]}`;
    const senderName = userData.user.user_metadata?.full_name || localPart;
    const fromHeader = `${senderName} <${fromAddress}>`;
    const replyTo = senderEmail || fromAddress;

    // Resolved HTML body (use provided body_html or convert body_text)
    const finalHtml = body_html && body_html.length > 0 ? body_html : textToHtml(body_text);

    // Insert email_sends row in 'queued' state FIRST so we have a tracking record
    const { data: sendRow, error: insErr } = await supabase
        .from("email_sends")
        .insert({
            sender_user_id: senderId,
            from_address: fromAddress,
            reply_to: replyTo,
            to_address: recipient_email,
            subject,
            template_key: template_key || null,
            send_status: "queued",
        })
        .select()
        .single();
    if (insErr || !sendRow) return err("Could not log email send: " + (insErr?.message || "unknown"), 500);

    // Send via Resend
    const resendBody: Record<string, unknown> = {
        from: fromHeader,
        to: [recipient_email],
        subject,
        html: finalHtml,
        text: body_text,
        reply_to: replyTo,
    };

    let resendMsgId: string | null = null;
    let resendErr: string | null = null;
    try {
        const r = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${RESEND_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(resendBody),
        });
        const respJson: any = await r.json().catch(() => ({}));
        if (!r.ok) {
            resendErr = respJson.message || respJson.error || `Resend HTTP ${r.status}`;
        } else {
            resendMsgId = respJson.id || null;
        }
    } catch (e: any) {
        resendErr = `Network error: ${e.message || "unknown"}`;
    }

    // Update email_sends with result
    if (resendErr) {
        await supabase
            .from("email_sends")
            .update({ send_status: "failed", error_message: resendErr })
            .eq("id", sendRow.id);
        return err(`Send failed: ${resendErr}`, 502);
    }

    await supabase
        .from("email_sends")
        .update({
            send_status: "sent",
            sent_at: new Date().toISOString(),
            resend_message_id: resendMsgId,
        })
        .eq("id", sendRow.id);

    return json({
        ok: true,
        send_id: sendRow.id,
        from: fromAddress,
        to: recipient_email,
        resend_message_id: resendMsgId,
    });
});
