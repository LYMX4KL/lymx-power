// =============================================================================
// LYMX Power — Customer Welcome Email (locale-aware)
// =============================================================================
// POST /functions/v1/customer-welcome-email
//
// Sends a friendly welcome email to a newly-signed-up customer. Auto-detects
// the recipient's locale (preferred_locale on customers/businesses/partners,
// falls back to a request hint, then English). Non-English bodies are passed
// through translate-text Edge Function so the customer reads in their language.
//
// Called by:
//   * business-signup-bonus as a side-effect after the +100 LYMX bonus issues
//   * (Future) manual admin send via admin tools
//
// REQUEST BODY:
//   {
//     user_id: string,                // required — auth.users.id
//     bonus_amount?: number,          // optional, e.g. 100
//     business_name?: string,         // optional, e.g. "Brew & Bean"
//     business_slug?: string,         // optional, used for browse link
//     locale_hint?: string            // optional, browser locale at signup
//   }
//
// RESPONSE (200):
//   { ok: true, email_send_id, locale_used, translated: boolean }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const err  = (m: string, s = 400) => json({ ok: false, error: m }, s);

const SUPPORTED = ["en", "es", "zh-CN", "zh-TW", "ko", "ja"];

function escHtml(s: string): string {
    return String(s == null ? "" : s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;" }[c] as string));
}

// English template — the source of truth. Translations happen at send time.
function composeWelcomeEnglish(opts: { firstName: string; bonusAmount: number | null; businessName: string | null; businessSlug: string | null; }): { subject: string; body_text: string } {
    const greet = opts.firstName ? `Hi ${opts.firstName},` : "Hi there,";
    const bonusLine = opts.bonusAmount
        ? `Your LYMX wallet has ${opts.bonusAmount} LYMX waiting for you — that's our welcome bonus.`
        : `Your LYMX wallet is ready to go.`;
    const bizLine = opts.businessName
        ? `You joined us via ${opts.businessName}. The next time you spend there, you'll earn more LYMX automatically — just show your phone number at checkout.`
        : `Show your phone number at checkout at any LYMX business and you'll earn rewards automatically.`;

    const subject = opts.businessName
        ? `Welcome to LYMX — ${opts.bonusAmount ?? 0} LYMX is in your wallet (from ${opts.businessName})`
        : `Welcome to LYMX — your wallet is ready`;

    const body_text = `${greet}

Welcome to LYMX. We're glad you're here.

${bonusLine}

${bizLine}

3 things to try first:
1. Browse local businesses on the network at https://getlymx.com/browse.html
2. Send a friend an invite (you both earn 100 LYMX) at https://getlymx.com/refer.html
3. See your wallet anytime at https://getlymx.com/customer-wallet.html

Reply to this email anytime if you have a question — a real person on our team will see it.

Thanks for joining,
Kenny + the LYMX team`;

    return { subject, body_text };
}

async function translateIfNeeded(supabase: ReturnType<typeof createClient>, anon: string, supabaseUrl: string, text: string, targetLocale: string, context: string): Promise<string> {
    if (targetLocale === "en" || !SUPPORTED.includes(targetLocale)) return text;
    try {
        const r = await fetch(supabaseUrl + "/functions/v1/translate-text", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${anon}`, "apikey": anon },
            body: JSON.stringify({ text, target_locale: targetLocale, source_locale: "en", context }),
        });
        if (!r.ok) return text;
        const j = await r.json();
        return j.ok ? (j.translated_text || text) : text;
    } catch { return text; }
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return err("Method not allowed", 405);

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const ANON   = Deno.env.get("SUPABASE_ANON_KEY");
    const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
    if (!SB_URL || !SB_KEY || !ANON) return err("Server config missing", 500);
    if (!RESEND_KEY) return err("RESEND_API_KEY not configured", 500);
    const supabase = createClient(SB_URL, SB_KEY);

    let body: any;
    try { body = await req.json(); } catch { return err("Invalid JSON", 400); }
    const { user_id, bonus_amount, business_name, business_slug, locale_hint } = body || {};
    if (!user_id) return err("user_id is required", 400);

    // Resolve user identity
    const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(user_id);
    if (userErr || !userData?.user) return err("User not found: " + (userErr?.message || ""), 404);
    const user = userData.user;
    const toEmail = user.email;
    if (!toEmail) return err("User has no email on file", 422);
    const meta = (user.user_metadata || {}) as Record<string, unknown>;
    const firstName = (meta.first_name as string) || (meta.full_name as string)?.split(" ")[0] || "";

    // Resolve locale: preferred_locale on customers/businesses/partners → request hint → English
    let locale = "en";
    try {
        const { data: locData } = await supabase.rpc("fn_resolve_recipient_locale", { p_user_id: user_id });
        if (locData && SUPPORTED.includes(locData as string)) locale = locData as string;
    } catch { /* fn might not exist */ }
    if (locale === "en" && locale_hint && SUPPORTED.includes(locale_hint)) locale = locale_hint;

    // Compose English version
    const composed = composeWelcomeEnglish({
        firstName,
        bonusAmount: typeof bonus_amount === "number" ? bonus_amount : null,
        businessName: business_name || null,
        businessSlug: business_slug || null,
    });

    // Translate body + subject if needed
    let subject = composed.subject;
    let body_text = composed.body_text;
    let translated = false;
    if (locale !== "en") {
        subject = await translateIfNeeded(supabase, ANON, SB_URL, composed.subject, locale, "email subject line, marketing tone");
        body_text = await translateIfNeeded(supabase, ANON, SB_URL, composed.body_text, locale, "warm welcome email from a small rewards startup; preserve the warm friendly tone and any URLs or numbers as-is");
        translated = (subject !== composed.subject) || (body_text !== composed.body_text);
    }

    // HTML version
    const body_html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#0e1116;max-width:600px;margin:0 auto;padding:20px">`
        + escHtml(body_text)
            .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#0a84ff;text-decoration:none">$1</a>')
            .replace(/\n\n/g, '</p><p style="margin:14px 0">')
            .replace(/\n/g, '<br>')
        + `</div>`;

    // Log to email_sends first (transactional channel)
    const fromAddress = "Kenny <kenny@getlymx.com>";
    const { data: sendRow, error: sendErr } = await supabase
        .from("email_sends").insert({
            sender_user_id: null,
            from_address: "kenny@getlymx.com",
            reply_to: "kenny@getlymx.com",
            to_address: toEmail,
            subject,
            template_key: "customer_welcome",
            send_status: "queued",
        }).select().single();
    if (sendErr || !sendRow) return err("Could not log send: " + (sendErr?.message || ""), 500);

    // Send via Resend
    try {
        const r = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                from: fromAddress,
                to: [toEmail],
                subject,
                html: `<p style="margin:14px 0">${body_html.replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '')}</p>`,
                text: body_text,
                reply_to: "kenny@getlymx.com",
            }),
        });
        const j: any = await r.json().catch(() => ({}));
        if (!r.ok) {
            await supabase.from("email_sends").update({ send_status: "failed", error_message: j.message || j.error || `HTTP ${r.status}` }).eq("id", sendRow.id);
            return err(`Resend failed: ${j.message || j.error || r.status}`, 502);
        }
        await supabase.from("email_sends").update({
            send_status: "sent",
            sent_at: new Date().toISOString(),
            resend_message_id: j.id || null,
        }).eq("id", sendRow.id);
        return json({ ok: true, email_send_id: sendRow.id, locale_used: locale, translated });
    } catch (e: any) {
        await supabase.from("email_sends").update({ send_status: "failed", error_message: `Network: ${e.message}` }).eq("id", sendRow.id);
        return err(`Network error: ${e.message}`, 502);
    }
});
