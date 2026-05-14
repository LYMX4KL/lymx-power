// =============================================================================
// LYMX Power — SMS Inbound Webhook  (Twilio)
// =============================================================================
// POST /functions/v1/sms-inbound
//
// Twilio posts a form-urlencoded body here when our number receives an SMS.
// We persist the inbound message to sms_messages with direction='inbound',
// match the from-number against partners/businesses/customers to resolve a
// recipient_user_id, and return empty TwiML so Twilio doesn't auto-reply.
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
    // Twilio signs URL + sorted-params-concatenated for form-urlencoded
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

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST")    return new Response("Method not allowed", { status: 405, headers: corsHeaders });

    const raw = await req.text();
    const params = new URLSearchParams(raw);

    // Optional verify
    const AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
    if (AUTH_TOKEN) {
        const ok = await verifyTwilioSig(req, raw, AUTH_TOKEN);
        if (!ok) return new Response("Bad signature", { status: 403, headers: corsHeaders });
    }

    const from   = params.get("From") || "";
    const to     = params.get("To")   || "";
    const bodyTx = params.get("Body") || "";
    const sid    = params.get("MessageSid") || params.get("SmsSid") || "";

    if (!from || !bodyTx) return emptyTwiml();

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SVC_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase     = createClient(SUPABASE_URL, SVC_KEY);

    // Try to resolve a user by phone — partners.phone, businesses.phone, contacts.phone
    let recipientUserId: string | null = null;
    const numClean = from.replace(/[^\d+]/g, "");
    for (const tbl of ["partners", "businesses"]) {
        const { data } = await supabase.from(tbl).select("user_id, phone").or(`phone.eq.${numClean},phone.eq.${from}`).maybeSingle();
        if (data?.user_id) { recipientUserId = data.user_id; break; }
    }

    await supabase.from("sms_messages").insert({
        sender_user_id:    null,
        recipient_user_id: recipientUserId,
        from_number:       from,
        to_number:         to,
        body:              bodyTx,
        direction:         "inbound",
        twilio_sid:        sid || null,
        send_status:       "received",
    });

    return emptyTwiml();
});
