// =============================================================================
// LYMX Power — Daily.co setup utility
// =============================================================================
// One-off helper to register the webhook with Daily.co from server-side, using
// the DAILY_API_KEY env var already in Supabase secrets. Avoids the clipboard
// dance of pasting the API key into PowerShell.
//
// Usage:
//   GET  /functions/v1/daily-setup?action=list      → list existing webhooks
//   POST /functions/v1/daily-setup?action=register  → create the call-summary webhook
//
// Output of register includes the `hmac` value Daily generates. PASTE that
// into a Supabase secret named DAILY_WEBHOOK_SECRET to enable HMAC validation
// on incoming webhook deliveries.
//
// Disable verify_jwt on this function in Supabase dashboard → Functions →
// daily-setup → Settings (it's a server-to-server tool, not user-facing).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    const DAILY_KEY = Deno.env.get("DAILY_API_KEY");
    if (!DAILY_KEY) return json({ ok: false, error: "DAILY_API_KEY not set in Supabase secrets" }, 500);

    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "list";

    if (action === "list" && req.method === "GET") {
        const r = await fetch("https://api.daily.co/v1/webhooks", {
            headers: { "Authorization": `Bearer ${DAILY_KEY}` },
        });
        return json({ ok: r.ok, status: r.status, daily: await r.json() }, r.ok ? 200 : 502);
    }

    if (action === "register" && req.method === "POST") {
        const webhookUrl = url.searchParams.get("url")
            || `${Deno.env.get("SUPABASE_URL")}/functions/v1/call-summary`;
        const r = await fetch("https://api.daily.co/v1/webhooks", {
            method: "POST",
            headers: { "Authorization": `Bearer ${DAILY_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                url: webhookUrl,
                eventTypes: ["meeting.ended", "transcript.ready", "recording.ready"],
            }),
        });
        const body = await r.json();
        return json({
            ok: r.ok,
            status: r.status,
            webhook_url: webhookUrl,
            daily: body,
            next_step: r.ok
                ? `If body.hmac is present, save it in Supabase secrets as DAILY_WEBHOOK_SECRET.`
                : `Daily rejected the registration. Inspect 'daily' for the reason.`,
        }, r.ok ? 200 : 502);
    }

    if (action === "delete" && req.method === "POST") {
        const id = url.searchParams.get("id");
        if (!id) return json({ ok: false, error: "Pass ?id=<webhook_uuid>" }, 400);
        const r = await fetch(`https://api.daily.co/v1/webhooks/${id}`, {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${DAILY_KEY}` },
        });
        return json({ ok: r.ok, status: r.status, daily: r.ok ? "deleted" : await r.text() }, r.ok ? 200 : 502);
    }

    return json({
        ok: false,
        error: "Unknown action",
        usage: {
            "GET  ?action=list": "list existing Daily webhooks",
            "POST ?action=register": "create the call-summary webhook (returns hmac)",
            "POST ?action=delete&id=<uuid>": "remove a webhook",
        },
    }, 400);
});
