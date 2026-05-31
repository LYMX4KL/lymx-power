// =============================================================================
// LYMX — send-business-integration-invite
//   POST /functions/v1/send-business-integration-invite   { "business_id": "uuid" }
// =============================================================================
// Sends the editable "build one read endpoint" integration letter to a member
// business's technical contact. Two callers, one path:
//   1. AUTO — the trigger fn_send_integration_invite_on_intake (mig 161) fires
//      this when intake_completed_at flips null -> set.
//   2. MANUAL — a marketing/onboarder button in the portal POSTs { business_id }.
//
// Deploy with verify_jwt = FALSE (the DB trigger calls it with no JWT). Safe to
// call openly: it only sends for an intake-COMPLETE business, only ONCE
// (business_integration_invite_log), and only to that business's own contact.
//
// Template text + subject live in public.email_templates (key
// 'business_integration_invite'); {{business_name}} is the only placeholder.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function escHtml(t: string): string {
    return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function textToHtml(text: string): string {
    const html = escHtml(text).replace(/\n/g, "<br>");
    return '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Inter,Roboto,sans-serif;font-size:14px;line-height:1.6;color:#0e1116;white-space:normal">' + html + "</div>";
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
    if (!SB_URL || !SB_KEY) return json({ ok: false, error: "server_misconfigured" }, 500);
    const supabase = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

    let body: any;
    try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
    const businessId = (body?.business_id || "").trim();
    if (!businessId) return json({ ok: false, error: "missing_business_id" }, 400);

    // Load the business
    const { data: biz, error: bizErr } = await supabase
        .from("businesses")
        .select("id, display_name, legal_name, tech_contact_email, contact_email, intake_completed_at")
        .eq("id", businessId)
        .maybeSingle();
    if (bizErr) return json({ ok: false, error: "lookup_failed", detail: bizErr.message }, 500);
    if (!biz) return json({ ok: false, error: "business_not_found" }, 404);
    if (!biz.intake_completed_at) return json({ ok: false, skipped: "no_intake" });

    // Send once
    const { data: prior } = await supabase
        .from("business_integration_invite_log")
        .select("business_id, sent_to, status").eq("business_id", businessId).maybeSingle();
    if (prior) return json({ ok: true, already_sent: true, sent_to: prior.sent_to });

    const recipient = (biz.tech_contact_email || biz.contact_email || "").trim();
    if (!recipient) {
        await supabase.from("business_integration_invite_log")
            .insert({ business_id: businessId, sent_to: null, status: "no_recipient" });
        return json({ ok: false, error: "no_recipient" });
    }

    // Load + fill template
    const { data: tpl } = await supabase
        .from("email_templates").select("subject, body").eq("key", "business_integration_invite").maybeSingle();
    if (!tpl) return json({ ok: false, error: "template_missing" }, 500);
    const name = biz.display_name || biz.legal_name || "there";
    const subject = tpl.subject.replace(/\{\{business_name\}\}/g, name);
    const text = tpl.body.replace(/\{\{business_name\}\}/g, name);

    if (!RESEND_KEY) return json({ ok: false, error: "email_not_configured" }, 500);
    const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
            from: "LYMX <onboarding@getlymx.com>",
            to: [recipient],
            subject,
            text,
            html: textToHtml(text),
        }),
    });
    const rj = await r.json().catch(() => ({}));
    const status = r.ok ? "sent" : "failed";
    await supabase.from("business_integration_invite_log")
        .insert({ business_id: businessId, sent_to: recipient, status });
    if (!r.ok) return json({ ok: false, error: "send_failed", detail: rj }, 502);
    return json({ ok: true, sent_to: recipient });
});
