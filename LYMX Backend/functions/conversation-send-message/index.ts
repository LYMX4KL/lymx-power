// =============================================================================
// LYMX Power — Send a Conversation Message (unified comms)
// =============================================================================
// POST /functions/v1/conversation-send-message
//
// Sends one message inside a Conversation thread. The "channel" determines
// what side-effect delivery happens:
//
//   in_app    → just insert conversation_messages (other participants see it
//               when they refresh / via realtime).
//   email_out → ALSO send via Resend, log email_sends, link email_send_id.
//   sms_out   → ALSO send via Twilio, log sms_messages, link sms_message_id.
//
// Caller can EITHER pass an existing conversation_id OR (subject_type +
// subject_id + kind) to find-or-create a thread.
//
// Mirrors InvestPro PM's owner/tenant communications API: every send is
// stamped with sender_user_id (the team member), timestamped, and contributes
// to last_handled_by + last_handled_at via the conv_msg_after_insert trigger.
// =============================================================================
//
// REQUEST BODY:
//   {
//     // Option A: existing thread
//     conversation_id?: string,
//
//     // Option B: find-or-create
//     subject_type?: "customer" | "business" | "partner" | "none",
//     subject_id?: string,                  // required if subject_type != "none"
//     kind?: "support" | "feedback" | "bug" | "sales" | "onboarding" | "compliance" | "general",
//     title?: string,
//
//     // Required for ALL channels
//     channel: "in_app" | "email_out" | "sms_out",
//     body: string,
//
//     // Optional metadata
//     subject_line?: string,                // for emails
//     body_html?: string,                   // for emails (rich)
//     is_internal_note?: boolean,           // admin-only sidebar note, hidden from subject
//
//     // For email_out
//     email_channel?: "outreach" | "transactional",  // default "transactional"
//     to_email?: string,                    // override; default: resolve from subject
//     cc_emails?: string[],
//
//     // For sms_out
//     to_phone?: string,                    // override; default: resolve from subject
//
//     // For peer-to-peer / cc
//     participant_user_ids?: string[]       // add these users to the thread
//   }
//
// RESPONSE (200):
//   {
//     ok: true,
//     conversation_id,
//     message_id,
//     channel,
//     email_send_id?,
//     sms_message_id?,
//     resend_message_id?,
//     twilio_sid?
//   }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lymx-api-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const err = (m: string, s = 400) => json({ ok: false, error: m }, s);

const CHANNEL_DOMAINS: Record<string, string> = {
    outreach:      "lymxpower.com",
    transactional: "getlymx.com",
};

function escHtml(s: string): string {
    return String(s == null ? "" : s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;" }[c] as string));
}
function textToHtml(text: string): string {
    let html = escHtml(text);
    html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    html = html.replace(/\n/g, "<br>");
    return "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#0e1116\">" + html + "</div>";
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return err("Method not allowed", 405);

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
    const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
    const TWILIO_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
    const TWILIO_FROM = Deno.env.get("TWILIO_FROM_NUMBER");

    if (!SB_URL || !SB_KEY) return err("Server config missing", 500);
    const supabase = createClient(SB_URL, SB_KEY);

    // ----- Auth -----
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return err("Unauthorized", 401);
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return err("Invalid token", 401);

    const senderUserId = userData.user.id;
    const senderEmail = userData.user.email;
    const senderName = userData.user.user_metadata?.full_name || (senderEmail ? senderEmail.split("@")[0] : "Unknown");

    // ----- Parse body -----
    let body: any;
    try { body = await req.json(); } catch { return err("Invalid JSON", 400); }

    const channel: string = body.channel;
    if (!["in_app", "email_out", "sms_out"].includes(channel)) return err("channel must be in_app | email_out | sms_out", 400);

    const messageBody: string = (body.body || "").toString();
    if (!messageBody.trim()) return err("body is required", 400);

    // ----- Resolve conversation -----
    let conversationId: string | null = body.conversation_id || null;

    if (!conversationId) {
        const subjectType = body.subject_type || "none";
        const subjectId = body.subject_id || null;
        if (subjectType !== "none" && !subjectId) return err("subject_id required when subject_type != none", 400);
        const kind = body.kind || "general";

        // Call the SQL RPC
        const { data: convId, error: rpcErr } = await supabase.rpc("fn_find_or_create_conversation", {
            p_subject_type: subjectType,
            p_subject_id:   subjectId,
            p_kind:         kind,
            p_title:        body.title || null,
            p_source:       "api",
            p_created_by:   senderUserId,
        });
        if (rpcErr) return err("Could not resolve conversation: " + rpcErr.message, 500);
        conversationId = convId as unknown as string;
    }

    if (!conversationId) return err("conversation_id resolution failed", 500);

    // ----- Determine if sender is admin (for sender_type) -----
    const { data: staffRow } = await supabase
        .from("staff_roles")
        .select("user_id")
        .eq("user_id", senderUserId)
        .maybeSingle();
    const isAdmin = !!staffRow;

    let senderType: string;
    if (isAdmin) {
        senderType = "admin";
    } else {
        const { data: partnerRow } = await supabase
            .from("partners").select("id").eq("user_id", senderUserId).maybeSingle();
        if (partnerRow) {
            senderType = "partner";
        } else {
            const { data: bizRow } = await supabase
                .from("businesses").select("id").eq("owner_user_id", senderUserId).maybeSingle();
            senderType = bizRow ? "business" : "customer";
        }
    }

    // ----- Add explicit participants if requested -----
    const participantIds: string[] = Array.isArray(body.participant_user_ids) ? body.participant_user_ids : [];
    if (participantIds.length > 0) {
        const rows = participantIds.map(uid => ({
            conversation_id: conversationId,
            user_id: uid,
            role: "cc",
        }));
        await supabase.from("conversation_participants").upsert(rows, { onConflict: "conversation_id,user_id", ignoreDuplicates: true });
    }

    // ----- Side-effect: email_out -----
    let emailSendId: string | null = null;
    let resendMessageId: string | null = null;

    if (channel === "email_out") {
        if (!RESEND_KEY) return err("RESEND_API_KEY not configured", 500);

        // Resolve recipient email
        let toEmail: string | null = body.to_email || null;
        if (!toEmail) {
            // Look up the subject's contact email
            const { data: conv } = await supabase.from("conversations").select("*").eq("id", conversationId).single();
            if (conv) {
                if (conv.subject_type === "customer" && conv.subject_customer_id) {
                    const { data: c } = await supabase.from("customers").select("email").eq("id", conv.subject_customer_id).single();
                    toEmail = c?.email || null;
                } else if (conv.subject_type === "business" && conv.subject_business_id) {
                    const { data: b } = await supabase.from("businesses").select("contact_email").eq("id", conv.subject_business_id).single();
                    toEmail = b?.contact_email || null;
                } else if (conv.subject_type === "partner" && conv.subject_partner_id) {
                    const { data: p } = await supabase.from("partners").select("contact_email").eq("id", conv.subject_partner_id).single();
                    toEmail = p?.contact_email || null;
                }
            }
        }
        if (!toEmail) return err("Could not resolve recipient email — pass to_email or set subject contact_email", 422);

        // Resolve sender alias
        const emailChannel = body.email_channel === "outreach" ? "outreach" : "transactional";
        let localPart = "";
        const { data: aliasRow } = await supabase
            .from("partner_emails").select("local_part")
            .eq("forward_to", senderEmail).eq("status", "active").maybeSingle();
        localPart = aliasRow?.local_part || (senderEmail ? senderEmail.split("@")[0].toLowerCase() : "noreply");
        const fromAddress = `${localPart}@${CHANNEL_DOMAINS[emailChannel]}`;
        const fromHeader = `${senderName} <${fromAddress}>`;

        const subjectLine = body.subject_line || `Re: LYMX Power`;
        const finalHtml = body.body_html && body.body_html.length > 0 ? body.body_html : textToHtml(messageBody);

        // Pre-insert email_sends in queued state
        const { data: sendRow, error: sendInsErr } = await supabase
            .from("email_sends")
            .insert({
                sender_user_id: senderUserId,
                from_address: fromAddress,
                reply_to: senderEmail || fromAddress,
                to_address: toEmail,
                subject: subjectLine,
                conversation_id: conversationId,
                send_status: "queued",
            })
            .select().single();
        if (sendInsErr || !sendRow) return err("Could not log email send: " + (sendInsErr?.message || "unknown"), 500);
        emailSendId = sendRow.id;

        try {
            const r = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    from: fromHeader,
                    to: [toEmail],
                    cc: Array.isArray(body.cc_emails) ? body.cc_emails : undefined,
                    subject: subjectLine,
                    html: finalHtml,
                    text: messageBody,
                    reply_to: senderEmail || fromAddress,
                    headers: { "X-LYMX-Conversation-Id": conversationId },
                }),
            });
            const respJson: any = await r.json().catch(() => ({}));
            if (!r.ok) {
                await supabase.from("email_sends").update({
                    send_status: "failed", error_message: respJson.message || respJson.error || `HTTP ${r.status}`,
                }).eq("id", emailSendId);
                return err(`Resend failed: ${respJson.message || respJson.error || r.status}`, 502);
            }
            resendMessageId = respJson.id || null;
            await supabase.from("email_sends").update({
                send_status: "sent", sent_at: new Date().toISOString(), resend_message_id: resendMessageId,
            }).eq("id", emailSendId);
        } catch (e: any) {
            await supabase.from("email_sends").update({
                send_status: "failed", error_message: `Network error: ${e.message || "unknown"}`,
            }).eq("id", emailSendId);
            return err(`Resend network error: ${e.message}`, 502);
        }
    }

    // ----- Side-effect: sms_out -----
    let smsMessageId: string | null = null;
    let twilioSid: string | null = null;

    if (channel === "sms_out") {
        if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) return err("Twilio not configured", 500);

        let toPhone: string | null = body.to_phone || null;
        if (!toPhone) {
            const { data: conv } = await supabase.from("conversations").select("*").eq("id", conversationId).single();
            if (conv?.subject_type === "customer" && conv.subject_customer_id) {
                const { data: c } = await supabase.from("customers").select("phone").eq("id", conv.subject_customer_id).single();
                toPhone = c?.phone || null;
            } else if (conv?.subject_type === "business" && conv.subject_business_id) {
                const { data: b } = await supabase.from("businesses").select("contact_phone").eq("id", conv.subject_business_id).single();
                toPhone = b?.contact_phone || null;
            } else if (conv?.subject_type === "partner" && conv.subject_partner_id) {
                const { data: p } = await supabase.from("partners").select("contact_phone").eq("id", conv.subject_partner_id).single();
                toPhone = p?.contact_phone || null;
            }
        }
        if (!toPhone) return err("Could not resolve recipient phone — pass to_phone or set subject contact_phone", 422);

        const { data: smsRow, error: smsInsErr } = await supabase
            .from("sms_messages").insert({
                sender_user_id: senderUserId,
                from_number: TWILIO_FROM,
                to_number: toPhone,
                body: messageBody,
                direction: "outbound",
                send_status: "queued",
                conversation_id: conversationId,
            }).select().single();
        if (smsInsErr || !smsRow) return err("Could not log SMS: " + (smsInsErr?.message || "unknown"), 500);
        smsMessageId = smsRow.id;

        try {
            const auth = btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`);
            const params = new URLSearchParams({ From: TWILIO_FROM, To: toPhone, Body: messageBody });
            const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
                method: "POST",
                headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
                body: params.toString(),
            });
            const respJson: any = await r.json().catch(() => ({}));
            if (!r.ok) {
                await supabase.from("sms_messages").update({
                    send_status: "failed", error_code: String(respJson.code || ""), error_message: respJson.message || `HTTP ${r.status}`,
                }).eq("id", smsMessageId);
                return err(`Twilio failed: ${respJson.message || r.status}`, 502);
            }
            twilioSid = respJson.sid || null;
            await supabase.from("sms_messages").update({
                send_status: "sent", twilio_sid: twilioSid,
            }).eq("id", smsMessageId);
        } catch (e: any) {
            await supabase.from("sms_messages").update({
                send_status: "failed", error_message: `Network error: ${e.message || "unknown"}`,
            }).eq("id", smsMessageId);
            return err(`Twilio network error: ${e.message}`, 502);
        }
    }

    // Resolve sender's locale so the message is tagged for later translation.
    let senderLocale: string | null = null;
    try {
        const { data: locData } = await supabase.rpc("fn_resolve_recipient_locale", { p_user_id: senderUserId });
        senderLocale = (locData as string) || null;
    } catch { /* fn might not exist if migration 038 not applied yet */ }

    // ----- Insert the conversation_messages row -----
    const { data: msgRow, error: msgErr } = await supabase
        .from("conversation_messages")
        .insert({
            conversation_id: conversationId,
            sender_user_id: senderUserId,
            sender_type: senderType,
            sender_name_snapshot: senderName,
            sender_address_snapshot: senderEmail,
            channel,
            subject_line: body.subject_line || null,
            body: messageBody,
            body_html: body.body_html || null,
            external_id: resendMessageId || twilioSid || null,
            direction: (channel === "email_out" || channel === "sms_out") ? "outbound" : "internal",
            to_addresses: body.to_email ? [body.to_email] : (body.to_phone ? [body.to_phone] : []),
            email_send_id: emailSendId,
            sms_message_id: smsMessageId,
            is_internal_note: !!body.is_internal_note,
            source_locale: senderLocale || body.source_locale || null,
        })
        .select().single();
    if (msgErr || !msgRow) return err("Could not insert message: " + (msgErr?.message || "unknown"), 500);

    return json({
        ok: true,
        conversation_id: conversationId,
        message_id: msgRow.id,
        channel,
        email_send_id: emailSendId,
        sms_message_id: smsMessageId,
        resend_message_id: resendMessageId,
        twilio_sid: twilioSid,
    });
});
