// =============================================================================
// LYMX — send-claim-invite
//   POST /functions/v1/send-claim-invite   { "claim_id": "uuid" }
// =============================================================================
// Emails a no-wallet customer an invite to JOIN and CLAIM the LYMX a business
// already rewarded them (a lymx_pending_claims row). Two callers, one path:
//   1. AUTO — trigger fn_send_claim_invite_on_insert (mig 164) fires this on a
//      new pending claim.
//   2. MANUAL/BACKFILL — POST { claim_id } to fire for an existing claim.
//
// Deploy with verify_jwt = FALSE (the DB trigger calls it with no JWT). Safe to
// call openly: it only sends for a PENDING claim that has a customer_email, and
// only ONCE (lymx_pending_claims.invite_emailed_at).
//
// Copy lives in public.email_templates (key 'customer_claim_invite'); the EF
// fills {{lymx_amount}} {{dollar_value}} {{business_name}} {{claim_url}}
// {{expires_date}} {{browse_url}}.
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
    // Linkify bare URLs so the claim + browse links are clickable in HTML clients.
    const html = escHtml(text)
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#0a84ff;font-weight:600">$1</a>')
        .replace(/\n/g, "<br>");
    return '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Inter,Roboto,sans-serif;font-size:14px;line-height:1.6;color:#0e1116;white-space:normal">' + html + "</div>";
}

const CLAIM_BASE = "https://getlymx.com/welcome.html";
const BROWSE_URL = "https://getlymx.com/browse.html";

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
    const claimId = (body?.claim_id || "").trim();
    if (!claimId) return json({ ok: false, error: "missing_claim_id" }, 400);

    // Load the claim
    const { data: claim, error: cErr } = await supabase
        .from("lymx_pending_claims")
        .select("id, business_id, customer_email, lymx_amount, invite_token, status, expires_at, invite_emailed_at")
        .eq("id", claimId)
        .maybeSingle();
    if (cErr) return json({ ok: false, error: "lookup_failed", detail: cErr.message }, 500);
    if (!claim) return json({ ok: false, error: "claim_not_found" }, 404);
    if (claim.invite_emailed_at) return json({ ok: true, already_sent: true });
    if (claim.status !== "pending") return json({ ok: true, skipped: "status_" + claim.status });
    const recipient = (claim.customer_email || "").trim();
    if (!recipient) {
        await supabase.from("lymx_pending_claims")
            .update({ invite_emailed_at: new Date().toISOString(), invite_email_status: "no_recipient" })
            .eq("id", claim.id);
        return json({ ok: false, error: "no_recipient" });
    }

    // Business name
    const { data: biz } = await supabase
        .from("businesses").select("display_name, legal_name").eq("id", claim.business_id).maybeSingle();
    const bizName = (biz?.display_name || biz?.legal_name || "A LYMX business");

    // Load + fill template
    const { data: tpl } = await supabase
        .from("email_templates").select("subject, body").eq("key", "customer_claim_invite").maybeSingle();
    if (!tpl) return json({ ok: false, error: "template_missing" }, 500);

    const dollarValue = (Number(claim.lymx_amount || 0) / 100).toFixed(2);
    const claimUrl = `${CLAIM_BASE}?claim=${claim.invite_token}`;
    let expiresDate = "soon";
    if (claim.expires_at) {
        try {
            expiresDate = new Date(claim.expires_at).toLocaleDateString("en-US",
                { month: "long", day: "numeric", year: "numeric" });
        } catch (_e) { /* leave default */ }  // bandaid-ok: date format is cosmetic; falls back to "soon"
    }
    const fill = (s: string) => s
        .replace(/\{\{lymx_amount\}\}/g, String(claim.lymx_amount))
        .replace(/\{\{dollar_value\}\}/g, dollarValue)
        .replace(/\{\{business_name\}\}/g, bizName)
        .replace(/\{\{claim_url\}\}/g, claimUrl)
        .replace(/\{\{expires_date\}\}/g, expiresDate)
        .replace(/\{\{browse_url\}\}/g, BROWSE_URL);

    const subject = fill(tpl.subject);
    const text = fill(tpl.body);

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
    await supabase.from("lymx_pending_claims")
        .update({ invite_emailed_at: new Date().toISOString(), invite_email_status: status })
        .eq("id", claim.id);
    if (!r.ok) return json({ ok: false, error: "send_failed", detail: rj }, 502);
    return json({ ok: true, sent_to: recipient, lymx_amount: claim.lymx_amount });
});
