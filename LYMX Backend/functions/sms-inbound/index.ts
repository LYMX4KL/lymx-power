// =============================================================================
// LYMX Power — SMS Inbound Webhook  (Twilio)  [updated for conversations]
// =============================================================================
// POST /functions/v1/sms-inbound
//
// Twilio posts a form-urlencoded body here when our number receives an SMS.
// We persist the inbound message to sms_messages AND route it into the
// appropriate conversation thread (mirroring InvestPro PM's owner/tenant
// communications model).
//
// Configure in Twilio console:
//   Phone Numbers → [your number] → "A MESSAGE COMES IN"
//   Webhook: https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/sms-inbound
//   HTTP POST
//
// Optional signature verification: set TWILIO_AUTH_TOKEN to verify the
// X-Twilio-Signature header (HMAC-SHA1 of full URL + sorted params).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-twilio-signature",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const emptyTwiml = () =>
    new Response("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>", {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/xml" },
    });

async function verifyTwilioSig(req: Request, raw: string, authToken: string): Promise<boolean> {
    const provided = req.headers.get("x-twilio-signature");
    if (!provided) return false;
    const url = new URL(req.url).toString();
    const params = new URLSearchParams(raw);
    const sortedKeys = Array.from(params.keys()).sort();
    let signing = url;
    for (const k of sortedKeys) signing += k + (params.get(k) || "");
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        "raw", enc.encode(authToken),
        { name: "HMAC", hash: "SHA-1" },
        false, ["sign"],
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(signing));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
    return sigB64 === provided;
}

function normalizePhone(p: string): string {
    return (p || "").replace(/[^\d+]/g, "");
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST")    return new Response("Method not allowed", { status: 405, headers: corsHeaders });

    const raw = await req.text();
    const params = new URLSearchParams(raw);

    // Optional signature verification
    const AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
    if (AUTH_TOKEN) {
        const sigOk = await verifyTwilioSig(req, raw, AUTH_TOKEN);
        if (!sigOk) return new Response("Bad signature", { status: 403, headers: corsHeaders });
    }

    const from   = params.get("From") || "";
    const to     = params.get("To")   || "";
    const bodyTx = params.get("Body") || "";
    const sid    = params.get("MessageSid") || params.get("SmsSid") || "";

    if (!from || !bodyTx) return emptyTwiml();

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SVC_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase     = createClient(SUPABASE_URL, SVC_KEY);

    // ---------------------------------------------------------------------
    // Resolve sender by phone — customers / businesses / partners
    // ---------------------------------------------------------------------
    const fromClean = normalizePhone(from);
    let senderUserId: string | null = null;
    let subjectType: "customer" | "business" | "partner" | "none" = "none";
    let subjectId: string | null = null;
    let senderType: "customer" | "business" | "partner" | "inbound_unknown" = "inbound_unknown";

    // customers.phone (required + unique on customers)
    const { data: cust } = await supabase.from("customers")
        .select("id, user_id, phone")
        .or(`phone.eq.${from},phone.eq.${fromClean}`)
        .maybeSingle();
    if (cust) {
        senderUserId = cust.user_id;
        subjectType = "customer";
        subjectId = cust.id;
        senderType = "customer";
    } else {
        // businesses.contact_phone
        const { data: biz } = await supabase.from("businesses")
            .select("id, owner_user_id, contact_phone")
            .or(`contact_phone.eq.${from},contact_phone.eq.${fromClean}`)
            .maybeSingle();
        if (biz) {
            senderUserId = biz.owner_user_id;
            subjectType = "business";
            subjectId = biz.id;
            senderType = "business";
        } else {
            // partners.contact_phone
            const { data: part } = await supabase.from("partners")
                .select("id, user_id, contact_phone")
                .or(`contact_phone.eq.${from},contact_phone.eq.${fromClean}`)
                .maybeSingle();
            if (part) {
                senderUserId = part.user_id;
                subjectType = "partner";
                subjectId = part.id;
                senderType = "partner";
            }
        }
    }

    // ---------------------------------------------------------------------
    // Find or create conversation (sticky to most recent open thread)
    // ---------------------------------------------------------------------
    let conversationId: string | null = null;
    if (subjectId) {
        const subjectColumn = subjectType === "customer" ? "subject_customer_id"
                            : subjectType === "business" ? "subject_business_id"
                            : "subject_partner_id";
        const { data: openConv } = await supabase
            .from("conversations").select("id")
            .eq("subject_type", subjectType)
            .eq(subjectColumn, subjectId)
            .in("status", ["open", "pending"])
            .order("last_message_at", { ascending: false, nullsFirst: false })
            .limit(1).maybeSingle();
        if (openConv) conversationId = openConv.id;
    }

    if (!conversationId) {
        const { data: newId, error: rpcErr } = await supabase.rpc("fn_find_or_create_conversation", {
            p_subject_type: subjectType,
            p_subject_id:   subjectId,
            p_kind:         "support",
            p_title:        `SMS from ${from}`,
            p_source:       "inbound_sms",
            p_created_by:   senderUserId,
        });
        if (!rpcErr && newId) conversationId = newId as unknown as string;
    }

    // ---------------------------------------------------------------------
    // Persist to sms_messages (legacy log, still useful)
    // ---------------------------------------------------------------------
    const { data: smsRow } = await supabase.from("sms_messages").insert({
        sender_user_id:    null,
        recipient_user_id: senderUserId,
        from_number:       from,
        to_number:         to,
        body:              bodyTx,
        direction:         "inbound",
        twilio_sid:        sid || null,
        send_status:       "received",
        conversation_id:   conversationId,
    }).select().single();

    // ---------------------------------------------------------------------
    // Persist to conversation_messages (the unified inbox view)
    // ---------------------------------------------------------------------
    if (conversationId) {
        await supabase.from("conversation_messages").insert({
            conversation_id: conversationId,
            sender_user_id:  senderUserId,
            sender_type:     senderType,
            sender_address_snapshot: from,
            channel:         "sms_in",
            body:            bodyTx,
            external_id:     sid || null,
            direction:       "inbound",
            sms_message_id:  smsRow?.id || null,
        });

        // Re-open if was resolved/closed
        await supabase.from("conversations")
            .update({ status: "open" })
            .eq("id", conversationId)
            .in("status", ["resolved", "closed"]);
    }

    return emptyTwiml();
});
