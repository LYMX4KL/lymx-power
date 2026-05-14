// =============================================================================
// LYMX Power — Resend Webhook Receiver
// =============================================================================
// POST /functions/v1/resend-webhook
//
// Public endpoint (no JWT) that Resend posts to when a tracked email is
// delivered, opened, clicked, bounced, or complained.  Maps the event to a
// row in email_events (which then bumps denormalized columns on email_sends
// via the trigger added in migration 022).
//
// Configure in Resend dashboard → Webhooks → Add Endpoint:
//   URL:    https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/resend-webhook
//   Events: email.sent, email.delivered, email.delivery_delayed,
//           email.bounced, email.complained, email.opened, email.clicked
//
// Optional secret (recommended): set RESEND_WEBHOOK_SECRET on the function.
// Resend posts a Svix signature in headers; we verify HMAC-SHA256 if set.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, svix-id, svix-timestamp, svix-signature",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ok  = (body: unknown = { ok: true }) => new Response(JSON.stringify(body), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const err = (msg: string, status = 400) => new Response(JSON.stringify({ error: msg }), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// Resend event payload shape (as of 2026-05):
//   { type: 'email.delivered',
//     data: { email_id, from, to: [...], subject, created_at, ... } }
function mapEventType(t: string): string | null {
    if (!t) return null;
    if (t.startsWith("email.")) return t.slice("email.".length);
    return t;
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST")    return err("Method not allowed", 405);

    const SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET");
    const raw    = await req.text();

    // Optional signature verification (Svix). If the secret is unset we accept
    // the request — we deploy first, configure the secret + headers later.
    if (SECRET) {
        const svixId        = req.headers.get("svix-id");
        const svixTimestamp = req.headers.get("svix-timestamp");
        const svixSignature = req.headers.get("svix-signature");
        if (!svixId || !svixTimestamp || !svixSignature) {
            return err("Missing Svix headers.", 401);
        }
        try {
            const enc = new TextEncoder();
            const toSign = `${svixId}.${svixTimestamp}.${raw}`;
            // SECRET is "whsec_<base64>"; strip prefix
            const keyB64 = SECRET.startsWith("whsec_") ? SECRET.slice(6) : SECRET;
            const keyBytes = Uint8Array.from(atob(keyB64), c => c.charCodeAt(0));
            const cryptoKey = await crypto.subtle.importKey(
                "raw", keyBytes,
                { name: "HMAC", hash: "SHA-256" },
                false, ["sign"],
            );
            const sigBuf = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(toSign));
            const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
            // svix-signature header is "v1,<b64>" possibly comma-separated for rotated keys
            const candidates = svixSignature.split(" ")
                .map(s => s.trim()).filter(Boolean)
                .map(s => s.replace(/^v1,/, ""));
            if (!candidates.includes(sigB64)) {
                return err("Bad Svix signature.", 401);
            }
        } catch (e: any) {
            return err(`Sig verify failed: ${e.message}`, 401);
        }
    }

    let payload: any;
    try { payload = JSON.parse(raw); } catch { return err("Invalid JSON.", 400); }

    const type      = mapEventType(String(payload?.type || ""));
    const data      = payload?.data || {};
    const messageId = data?.email_id || data?.message_id || null;
    const toAddr    = Array.isArray(data?.to) ? (data.to[0] || null) : (typeof data?.to === "string" ? data.to : null);
    const userAgent = data?.user_agent || null;
    const clickUrl  = data?.link?.url || data?.url || null;
    const bounceRsn = data?.bounce?.message || data?.bounce_message || null;
    const occurred  = data?.created_at || new Date().toISOString();

    if (!type)      return err("Missing event type.", 400);
    if (!messageId) return err("Missing email_id.",   400);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SVC_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase     = createClient(SUPABASE_URL, SVC_KEY);

    // Insert event — trigger on email_events bumps email_sends denormalized cols
    const { error: insErr } = await supabase.from("email_events").insert({
        resend_message_id: messageId,
        event_type:        type,
        to_address:        toAddr,
        user_agent:        userAgent,
        click_url:         clickUrl,
        bounce_reason:     bounceRsn,
        raw_payload:       payload,
        occurred_at:       occurred,
    });
    if (insErr) return err(`DB insert failed: ${insErr.message}`, 500);

    return ok({ ok: true, type });
});
