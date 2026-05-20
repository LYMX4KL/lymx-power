// =============================================================================
// LYMX Power — Conversation Inbound Email Webhook
// =============================================================================
// POST /functions/v1/conversation-inbound-email
//
// Receives inbound emails (replies from customers/businesses/partners to our
// @getlymx.com or @lymxpower.com addresses) and routes them back into the
// conversation thread.
//
// Supported sources:
//   1. Resend Inbound (https://resend.com/docs/dashboard/inbound)
//      — POSTs JSON with email parsed: from, to, subject, text, html, headers
//   2. Cloudflare Email Routing → Worker (custom JSON)
//
// Routing logic (in priority order):
//   1. If the email contains X-LYMX-Conversation-Id header → route directly.
//   2. If the In-Reply-To / References headers match an outbound resend_message_id
//      → look up conversation_id from email_sends.
//   3. Resolve sender by from-address → look up most recent open conversation
//      for that user. If none, create a new one (kind='support').
//
// Logs message to conversation_messages with channel='email_in', sender_type
// reflects what we resolved the sender as.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, svix-id, svix-timestamp, svix-signature",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const bad = (m: string, s = 400) => new Response(JSON.stringify({ ok: false, error: m }), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function extractAddress(rawFrom: string): string {
    if (!rawFrom) return "";
    const m = rawFrom.match(/<([^>]+)>/);
    return (m ? m[1] : rawFrom).trim().toLowerCase();
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return bad("Method not allowed", 405);

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SB_URL || !SB_KEY) return bad("Server config missing", 500);
    const supabase = createClient(SB_URL, SB_KEY);

    // Parse webhook body (Resend Inbound or Cloudflare)
    let payload: any;
    try { payload = await req.json(); } catch { return bad("Invalid JSON", 400); }

    // Resend Inbound shape: { type: "email.received", data: { from, to, subject, text, html, headers, ... } }
    // Cloudflare custom: pass through similar shape directly
    const data = payload?.data || payload;
    if (!data) return bad("No data payload", 400);

    const fromRaw: string = data.from || data.From || "";
    const toRaw: string   = Array.isArray(data.to) ? data.to.join(",") : (data.to || data.To || "");
    const subject: string = data.subject || data.Subject || "";
    const textBody: string = data.text || data.Text || data.body_text || "";
    const htmlBody: string = data.html || data.Html || data.body_html || "";
    const messageId: string = data.message_id || data["Message-Id"] || data.headers?.["message-id"] || null;
    const inReplyTo: string = data.in_reply_to || data["In-Reply-To"] || data.headers?.["in-reply-to"] || null;
    const references: string = data.references || data.References || data.headers?.["references"] || null;
    const xConvIdHeader: string = data.headers?.["x-lymx-conversation-id"] || data.headers?.["X-LYMX-Conversation-Id"] || null;

    const fromAddr = extractAddress(fromRaw);
    if (!fromAddr) return bad("Could not extract from-address", 400);

    // ---------------------------------------------------------------------
    // STEP 1 — Resolve conversation
    // ---------------------------------------------------------------------
    let conversationId: string | null = null;

    // Priority 1: explicit header from our outbound
    if (xConvIdHeader) {
        const { data: c } = await supabase.from("conversations").select("id").eq("id", xConvIdHeader).maybeSingle();
        if (c) conversationId = c.id;
    }

    // Priority 2: In-Reply-To / References → email_sends.resend_message_id → conversation_id
    if (!conversationId && (inReplyTo || references)) {
        const candidates: string[] = [];
        if (inReplyTo) candidates.push(inReplyTo.replace(/[<>]/g, "").trim());
        if (references) references.split(/\s+/).forEach(r => candidates.push(r.replace(/[<>]/g, "").trim()));

        for (const candidate of candidates) {
            const { data: es } = await supabase
                .from("email_sends").select("conversation_id")
                .eq("resend_message_id", candidate).maybeSingle();
            if (es?.conversation_id) {
                conversationId = es.conversation_id;
                break;
            }
        }
    }

    // ---------------------------------------------------------------------
    // STEP 2 — Resolve sender user
    // ---------------------------------------------------------------------
    let senderUserId: string | null = null;
    let senderSubjectType: "customer" | "business" | "partner" | "none" = "none";
    let senderSubjectId: string | null = null;

    // customers.email
    const { data: cust } = await supabase.from("customers").select("id, user_id").ilike("email", fromAddr).maybeSingle();
    if (cust) {
        senderUserId = cust.user_id;
        senderSubjectType = "customer";
        senderSubjectId = cust.id;
    } else {
        // businesses.contact_email
        const { data: biz } = await supabase.from("businesses").select("id, owner_user_id").ilike("contact_email", fromAddr).maybeSingle();
        if (biz) {
            senderUserId = biz.owner_user_id;
            senderSubjectType = "business";
            senderSubjectId = biz.id;
        } else {
            // partners.contact_email
            const { data: part } = await supabase.from("partners").select("id, user_id").ilike("contact_email", fromAddr).maybeSingle();
            if (part) {
                senderUserId = part.user_id;
                senderSubjectType = "partner";
                senderSubjectId = part.id;
            }
        }
    }

    // ---------------------------------------------------------------------
    // STEP 2b — 2026-05-20 #8ae35834 — Resolve TARGET partner from To: address.
    //   When a prospect (cold lead, not in any of our tables) replies to a
    //   partner's @getlymx.com address, the EF couldn't figure out where the
    //   thread belonged — sender lookup fails, conversation got created with
    //   subject_type='none', partner never sees it in their inbox.
    //   Fix: look at TO addresses. If any matches a partner_emails.full_email,
    //   that partner OWNS this thread (subject_type='partner', subject_partner_id).
    //   The sender stays as 'inbound_unknown' but the conversation is correctly
    //   anchored.
    // ---------------------------------------------------------------------
    let targetPartnerId: string | null = null;
    if (senderSubjectType === "none" && toRaw) {
        const toList = toRaw.split(",").map((s: string) => extractAddress(s)).filter(Boolean);
        if (toList.length) {
            const { data: pe } = await supabase
                .from("partner_emails")
                .select("partner_id, full_email")
                .in("full_email", toList)
                .limit(1).maybeSingle();
            if (pe && pe.partner_id) {
                targetPartnerId = pe.partner_id;
                // Anchor the conversation to this partner — sender stays unknown
                senderSubjectType = "partner";
                senderSubjectId = pe.partner_id;
            }
        }
    }

    // ---------------------------------------------------------------------
    // STEP 3 — Fallback: most-recent-open for this sender, else create new
    // ---------------------------------------------------------------------
    if (!conversationId && senderSubjectId) {
        const subjectColumn = senderSubjectType === "customer" ? "subject_customer_id"
                            : senderSubjectType === "business" ? "subject_business_id"
                            : "subject_partner_id";
        const { data: openConv } = await supabase
            .from("conversations").select("id")
            .eq("subject_type", senderSubjectType)
            .eq(subjectColumn, senderSubjectId)
            .in("status", ["open", "pending"])
            .order("last_message_at", { ascending: false, nullsFirst: false })
            .limit(1).maybeSingle();
        if (openConv) conversationId = openConv.id;
    }

    if (!conversationId) {
        // Create a new thread
        const { data: newId, error: rpcErr } = await supabase.rpc("fn_find_or_create_conversation", {
            p_subject_type: senderSubjectType,
            p_subject_id:   senderSubjectId,
            p_kind:         "support",
            p_title:        subject || `Email from ${fromAddr}`,
            p_source:       "inbound_email",
            p_created_by:   senderUserId,
        });
        if (rpcErr || !newId) return bad("Could not create conversation: " + (rpcErr?.message || "unknown"), 500);
        conversationId = newId as unknown as string;
    }

    // ---------------------------------------------------------------------
    // STEP 4 — Insert the inbound message
    // ---------------------------------------------------------------------
    const senderType = senderSubjectType === "customer" ? "customer"
                     : senderSubjectType === "business" ? "business"
                     : senderSubjectType === "partner"  ? "partner"
                     : "inbound_unknown";

    const { data: msgRow, error: msgErr } = await supabase
        .from("conversation_messages").insert({
            conversation_id: conversationId,
            sender_user_id: senderUserId,
            sender_type: senderType,
            sender_address_snapshot: fromAddr,
            channel: "email_in",
            subject_line: subject,
            body: textBody || htmlBody || "(empty)",
            body_html: htmlBody || null,
            external_id: messageId,
            in_reply_to_external_id: inReplyTo,
            direction: "inbound",
            to_addresses: toRaw ? toRaw.split(",").map((s: string) => s.trim()) : [],
        }).select().single();
    if (msgErr) return bad("Could not insert message: " + msgErr.message, 500);

    // If conversation was resolved/closed, re-open it
    await supabase.from("conversations")
        .update({ status: "open" })
        .eq("id", conversationId)
        .in("status", ["resolved", "closed"]);

    return ok({
        ok: true,
        conversation_id: conversationId,
        message_id: msgRow.id,
        sender_resolved: !!senderUserId,
        sender_type: senderType,
        from_address: fromAddr,
    });
});
