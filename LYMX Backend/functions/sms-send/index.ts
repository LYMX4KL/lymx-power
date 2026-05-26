// =============================================================================
// LYMX Power — SMS Send Endpoint  (Twilio outbound)
// =============================================================================
// POST /functions/v1/sms-send
//
// Send a single SMS via Twilio.  Audit row written to sms_messages either way.
// If TWILIO_* env vars are unset the request 503s — the table + UI work either
// way (we deploy the plumbing before Twilio account is provisioned).
//
// Mirrors InvestPro's service-message.js "send" action (the outbound half).
//
// REQUEST BODY:
//   {
//     "to":     "+14155551234",
//     "body":   "Helen, your invite is here: https://getlymx.com/welcome.html?ref=...",
//     "recipient_user_id": "uuid" | null,
//     "broadcast_id":      "uuid" | null,
//     "feedback_id":       "uuid" | null
//   }
//
// AUTH: caller must be admin (Kenny's user_id in v1) OR have staff role.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// 2026-05-26 — staff gate moved to staff_roles-only (see below). Migration
// 015 seeds Kenny as admin so removing the UUID short-circuit doesn't lock
// him out, and Helen/future staff get through correctly.

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
const err = (msg: string, status = 400) => json({ error: msg }, status);

function userFromJwt(authHeader: string | null): string | null {
    if (!authHeader) return null;
    const tok = authHeader.replace(/^Bearer\s+/i, "").trim();
    const parts = tok.split(".");
    if (parts.length !== 3) return null;
    try {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        return payload.sub || null;
    } catch { return null; }
}

// Twilio's REST API expects basic auth + form-urlencoded body.
async function twilioSend(opts: {
    accountSid: string; authToken: string; fromNumber: string; to: string; body: string;
}): Promise<{ sid: string | null; status: string; errorCode: string | null; errorMessage: string | null }> {
    const params = new URLSearchParams();
    params.append("From", opts.fromNumber);
    params.append("To",   opts.to);
    params.append("Body", opts.body);

    const auth = btoa(`${opts.accountSid}:${opts.authToken}`);
    const url  = `https://api.twilio.com/2010-04-01/Accounts/${opts.accountSid}/Messages.json`;
    const res  = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Basic ${auth}`,
            "Content-Type":  "application/x-www-form-urlencoded",
        },
        body: params.toString(),
    });
    let payload: any = null;
    try { payload = await res.json(); } catch (e) { console.warn('[index.ts:L72] silent error', e); }
    if (!res.ok) {
        return {
            sid: null,
            status: "failed",
            errorCode: String(payload?.code || res.status),
            errorMessage: payload?.message || `HTTP ${res.status}`,
        };
    }
    return {
        sid: payload?.sid || null,
        status: payload?.status || "sent",
        errorCode: null,
        errorMessage: null,
    };
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST")    return err("Method not allowed", 405);

    const userId = userFromJwt(req.headers.get("Authorization"));
    if (!userId) return err("Sign in required.", 401);

    let body: any;
    try { body = await req.json(); } catch { return err("Invalid JSON.", 400); }

    const to       = String(body?.to   || "").trim();
    const msgBody  = String(body?.body || "").trim();
    if (!to || !/^\+?\d{10,15}$/.test(to.replace(/[\s\-()]/g, ""))) {
        return err("Invalid 'to' number — use E.164 like +14155551234.", 400);
    }
    if (!msgBody)            return err("Message body required.", 400);
    if (msgBody.length > 1600) return err("SMS too long (max 1600 chars).", 400);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SVC_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase     = createClient(SUPABASE_URL, SVC_KEY);

    // Authorize — staff_roles membership is the canonical staff check.
    // Applies uniformly to every signed-in user including Kenny.
    const { data: staff, error: staffErr } = await supabase
        .from("staff_roles").select("user_id").eq("user_id", userId).maybeSingle();
    if (staffErr) {
        console.warn(`[sms-send] staff_roles lookup failed for ${userId}:`, staffErr.message);
        return err("Staff check failed. Please try again.", 503);
    }
    if (!staff) return err("Staff only.", 403);

    const ACCT  = Deno.env.get("TWILIO_ACCOUNT_SID");
    const TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
    const FROM  = Deno.env.get("TWILIO_FROM_NUMBER");
    if (!ACCT || !TOKEN || !FROM) {
        // Log the attempt so the UI shows what we tried, but return 503
        await supabase.from("sms_messages").insert({
            sender_user_id:    userId,
            recipient_user_id: body?.recipient_user_id || null,
            broadcast_id:      body?.broadcast_id || null,
            feedback_id:       body?.feedback_id || null,
            from_number:       "",
            to_number:         to,
            body:              msgBody,
            direction:         "outbound",
            send_status:       "failed",
            error_message:     "TWILIO_* env vars not configured",
        });
        return err("Twilio not configured on server (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER).", 503);
    }

    const r = await twilioSend({ accountSid: ACCT, authToken: TOKEN, fromNumber: FROM, to, body: msgBody });

    const { data: row, error: insErr } = await supabase.from("sms_messages").insert({
        sender_user_id:    userId,
        recipient_user_id: body?.recipient_user_id || null,
        broadcast_id:      body?.broadcast_id || null,
        feedback_id:       body?.feedback_id  || null,
        from_number:       FROM,
        to_number:         to,
        body:              msgBody,
        direction:         "outbound",
        twilio_sid:        r.sid,
        send_status:       r.status === "failed" ? "failed" : "sent",
        error_code:        r.errorCode,
        error_message:     r.errorMessage,
        delivered_at:      null,
    }).select("id").single();
    if (insErr) console.warn("sms_messages insert failed:", insErr);

    if (r.status === "failed") {
        return err(r.errorMessage || "Twilio send failed", 502);
    }
    return json({ ok: true, sid: r.sid, status: r.status, row_id: row?.id });
});
