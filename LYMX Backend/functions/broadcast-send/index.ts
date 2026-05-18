// =============================================================================
// LYMX Power — Broadcast Send Endpoint
// =============================================================================
// POST /functions/v1/broadcast-send
//
// Resolves a broadcast (created by admin in admin-broadcast.html) to its
// recipient email list, then sends each one via Resend. Updates the
// broadcasts row with status, sent_count, sent_at, and any error.
//
// REQUEST BODY:
//   { "broadcast_id": "uuid" }
//
// AUTH: caller must be admin (Kenny's user_id in v1).
//
// RESPONSE (200):
//   { "success": true, "sent_count": 12, "skipped": 0, "errors": 0 }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const ADMIN_UUID = "1405bb50-2c97-48dd-bfa5-31f32320de9b";

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
const errorResponse = (message: string, status = 400) => json({ error: message }, status);

// Decode the user from the JWT (auth header). Returns user_id or null.
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

async function resolveAudience(
    supabase: ReturnType<typeof createClient>,
    audience: string,
    customEmails: string[] | null,
): Promise<{ emails: string[]; reason: string }> {
    if (audience === "custom") {
        return { emails: (customEmails || []).filter(e => /\S+@\S+\.\S+/.test(e)), reason: "custom list" };
    }

    // Try the dedicated tables first; fall back to auth.users metadata role lookup.
    if (audience === "all_partners") {
        const { data, error } = await supabase
            .from("partners")
            .select("contact_email")
            .eq("active", true);
        if (!error && data) return { emails: data.map((r: any) => r.contact_email).filter(Boolean), reason: "partners table" };
    }
    if (audience === "all_businesses") {
        const { data, error } = await supabase
            .from("businesses")
            .select("contact_email");
        if (!error && data) return { emails: data.map((r: any) => r.contact_email).filter(Boolean), reason: "businesses table" };
    }

    // Fall back to auth.users — service role can list them.
    const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) return { emails: [], reason: `listUsers failed: ${error.message}` };
    const all = (data.users || []).filter((u: any) => !!u.email);
    if (audience === "all_users") return { emails: all.map((u: any) => u.email!), reason: "auth.users (all)" };

    const wanted =
        audience === "all_partners"   ? ["partner"]   :
        audience === "all_businesses" ? ["business"]  :
        audience === "all_customers"  ? ["customer"]  : [];

    const filtered = all.filter((u: any) => {
        const r = (u.user_metadata && u.user_metadata.role) || (u.app_metadata && u.app_metadata.role);
        return wanted.includes(r);
    });
    return { emails: filtered.map((u: any) => u.email!), reason: `auth.users metadata.role in ${wanted.join(",")}` };
}

async function sendOne(opts: {
    apiKey: string;
    from: string;
    replyTo?: string | null;
    to: string;
    subject: string;
    html: string;
    text: string | null;
}): Promise<{ resend_id: string | null }> {
    const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            from: opts.from,
            reply_to: opts.replyTo || undefined,
            to: [opts.to],
            subject: opts.subject,
            html: opts.html,
            text: opts.text || undefined,
        }),
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Resend ${res.status}: ${errText.slice(0, 200)}`);
    }
    try {
        const j = await res.json();
        return { resend_id: j?.id || null };
    } catch {
        return { resend_id: null };
    }
}

function wrapHtml(subject: string, body_html: string): string {
    return `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0e1116;background:#f6f7f9;padding:24px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;padding:28px 32px;box-shadow:0 6px 24px rgba(14,17,22,.08)">
  <div style="font-size:22px;font-weight:800;color:#0e1116;margin-bottom:6px">${subject.replace(/[<>]/g, "")}</div>
  <hr style="border:0;border-top:1px solid #e6e8ec;margin:14px 0 18px" />
  <div style="font-size:15px;line-height:1.55;color:#1a1f27">${body_html}</div>
  <hr style="border:0;border-top:1px solid #e6e8ec;margin:24px 0 14px" />
  <div style="font-size:12px;color:#5b6472">Sent from LYMX · <a href="https://getlymx.com" style="color:#0050c7">getlymx.com</a></div>
</div></body></html>`;
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return errorResponse("Method not allowed", 405);

    // ---- Admin auth ---------------------------------------------------------
    const userId = userFromJwt(req.headers.get("Authorization"));
    if (userId !== ADMIN_UUID) return errorResponse("Admin only.", 403);

    // ---- Parse body ---------------------------------------------------------
    let body: any;
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON.", 400); }
    const broadcastId = (body && body.broadcast_id) as string | undefined;
    if (!broadcastId) return errorResponse("Missing broadcast_id.", 400);

    // ---- Service-role client ------------------------------------------------
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(SUPABASE_URL, SVC_KEY);

    // ---- Load the broadcast -------------------------------------------------
    const { data: bc, error: loadErr } = await supabase
        .from("broadcasts")
        .select("*")
        .eq("id", broadcastId)
        .single();
    if (loadErr || !bc) return errorResponse(`Broadcast not found: ${loadErr?.message || ""}`, 404);
    if (bc.status === "sent") return json({ success: true, message: "Already sent.", sent_count: bc.sent_count });

    // ---- Resolve audience ---------------------------------------------------
    await supabase.from("broadcasts").update({ status: "sending" }).eq("id", broadcastId);
    const { emails, reason } = await resolveAudience(supabase, bc.audience, bc.custom_emails);
    const uniq = Array.from(new Set(emails.map(e => e.trim().toLowerCase()).filter(Boolean)));

    // ---- Send via Resend ----------------------------------------------------
    // PER-PARTNER SENDER (Kenny 2026-05-14): every invite goes FROM the
    // sender's own auto-provisioned @lymxpower.com address (helen.chen@,
    // kenny.lin@, etc.) so replies route to the real human and the recipient
    // sees a personal message, not a corporate noreply.
    //
    // Lookup chain: broadcasts.created_by (user_id) → partners (user_id →
    // partner_id) → partner_emails (partner_id → secondary_full_email).
    // Fall back to EMAIL_FROM_MARKETING global secret if any link is missing.
    const RESEND = Deno.env.get("RESEND_API_KEY");
    let FROM     = Deno.env.get("EMAIL_FROM_MARKETING") || "LYMX <invites@getlymx.com>";
    let REPLY_TO = Deno.env.get("EMAIL_REPLY_TO") || null;
    try {
        if (bc.created_by) {
            const { data: prt } = await supabase
                .from("partners")
                .select("id, legal_name, display_name")
                .eq("user_id", bc.created_by)
                .maybeSingle();
            if (prt?.id) {
                // partner_emails actual schema: id, partner_id, local_part,
                // full_email, forward_to, display_name, status, ...
                // (FIXED 2026-05-15: was looking up wrong columns secondary_*)
                const { data: pe } = await supabase
                    .from("partner_emails")
                    .select("full_email, forward_to, status")
                    .eq("partner_id", prt.id)
                    .maybeSingle();
                if (pe?.full_email && pe.status !== "failed") {
                    const name = (prt.display_name || prt.legal_name || "").trim();
                    FROM = name ? `${name} <${pe.full_email}>` : pe.full_email;
                    // Reply-To goes to the partner's real inbox (forward_to) so
                    // recipients can reply and the partner sees it.
                    REPLY_TO = pe.forward_to || pe.full_email;
                }
            }
        }
    } catch (e) {
        console.warn("Per-partner sender lookup failed; falling back to global:", e);
    }
    if (!RESEND) {
        await supabase.from("broadcasts").update({
            status: "failed", error: "RESEND_API_KEY not configured", sent_at: new Date().toISOString(),
        }).eq("id", broadcastId);
        return errorResponse("RESEND_API_KEY not configured on server.", 500);
    }

    if (bc.channel === "in_app") {
        // No outbound — just mark as sent. The broadcasts row IS the in-app inbox.
        await supabase.from("broadcasts").update({
            status: "sent", sent_count: uniq.length, sent_at: new Date().toISOString(),
        }).eq("id", broadcastId);
        return json({ success: true, sent_count: uniq.length, mode: "in_app", reason });
    }

    // ----- Locale-aware translation -----
    // Build a per-recipient (email → locale) map by joining the audience emails
    // against customers/businesses/partners.preferred_locale. Then pre-translate
    // the body+subject ONCE per unique locale (cached in translation_cache).
    const SUPPORTED_LOC = ["en", "es", "zh-CN", "zh-TW", "ko", "ja"];
    const emailToLocale: Record<string, string> = {};
    try {
        const lowerEmails = uniq.map(e => e.toLowerCase());
        const tables = ["customers", "businesses", "partners"] as const;
        for (const tbl of tables) {
            const col = tbl === "businesses" ? "contact_email" : "email";
            // Use single-column query because PostgREST can OR but only safely with literal lists
            const { data: rows } = await supabase
                .from(tbl).select(`${col},preferred_locale`).in(col, lowerEmails);
            (rows || []).forEach((r: any) => {
                const em = (r[col] || "").toLowerCase();
                if (em && r.preferred_locale && SUPPORTED_LOC.includes(r.preferred_locale)) {
                    if (!emailToLocale[em]) emailToLocale[em] = r.preferred_locale;
                }
            });
        }
    } catch { /* on lookup failure all recipients default to en */ }

    // Pre-translate body+subject for each non-English locale that's actually needed.
    const localesInUse = new Set<string>(["en"]);
    uniq.forEach(e => { const loc = emailToLocale[e.toLowerCase()]; if (loc && loc !== "en") localesInUse.add(loc); });

    const translatedBundle: Record<string, { subject: string; html: string; text: string }> = {
        en: { subject: bc.subject, html: wrapHtml(bc.subject, bc.body_html), text: bc.body_text },
    };
    if (localesInUse.size > 1) {
        const SB_URL_VAL = Deno.env.get("SUPABASE_URL")!;
        const ANON_VAL = Deno.env.get("SUPABASE_ANON_KEY")!;
        const tx = async (text: string, locale: string, ctx: string): Promise<string> => {
            try {
                const r = await fetch(SB_URL_VAL + "/functions/v1/translate-text", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "apikey": ANON_VAL, "Authorization": "Bearer " + ANON_VAL },
                    body: JSON.stringify({ text, target_locale: locale, source_locale: "en", context: ctx }),
                });
                if (!r.ok) return text;
                const j = await r.json();
                return j.ok ? (j.translated_text || text) : text;
            } catch { return text; }
        };
        for (const loc of localesInUse) {
            if (loc === "en") continue;
            const sb = await tx(bc.subject, loc, "marketing email subject line");
            // Translate the plain-text version (cleaner for translation) then re-wrap
            const txt = await tx(bc.body_text, loc, "marketing broadcast email body from a small rewards platform; preserve URLs, numbers, and brand name LYMX as-is");
            const safeHtml = txt.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" style="color:#0a84ff">$1</a>').replace(/\n/g, "<br>");
            translatedBundle[loc] = { subject: sb, html: wrapHtml(sb, safeHtml), text: txt };
        }
    }

    let sent = 0, failed = 0;
    const errors: string[] = [];
    const resendIds: string[] = [];
    for (const to of uniq) {
        const recipLoc = emailToLocale[to.toLowerCase()] || "en";
        const pkg = translatedBundle[recipLoc] || translatedBundle["en"];
        let resendId: string | null = null;
        let sendStatus: "sent" | "failed" = "sent";
        let errMsg: string | null = null;
        try {
            const r = await sendOne({ apiKey: RESEND, from: FROM, replyTo: REPLY_TO, to, subject: pkg.subject, html: pkg.html, text: pkg.text });
            sent++;
            resendId = r.resend_id;
            if (resendId) resendIds.push(resendId);
        } catch (e: any) {
            failed++;
            sendStatus = "failed";
            errMsg = e.message;
            if (errors.length < 5) errors.push(`${to}: ${e.message}`);
        }
        // Log every send to email_sends so the resend-webhook can link delivery
        // events back to the row (mirror of InvestPro pattern, 2026-05-14 Kenny).
        try {
            await supabase.from("email_sends").insert({
                broadcast_id:      broadcastId,
                sender_user_id:    bc.created_by || null,
                from_address:      FROM,
                reply_to:          REPLY_TO,
                to_address:        to,
                subject:           pkg.subject,
                template_key:      "broadcast",
                resend_message_id: resendId,
                send_status:       sendStatus,
                error_message:     errMsg,
                sent_at:           sendStatus === "sent" ? new Date().toISOString() : null,
            });
        } catch { /* best-effort logging — never fails the broadcast */ }
        // light rate limit — Resend free tier is 100/day; pause 100ms between sends
        await new Promise(r => setTimeout(r, 100));
    }

    const finalStatus = failed === 0 ? "sent" : (sent === 0 ? "failed" : "sent");
    await supabase.from("broadcasts").update({
        status: finalStatus,
        sent_count: sent,
        sent_at: new Date().toISOString(),
        error: errors.length ? errors.join(" · ").slice(0, 500) : null,
    }).eq("id", broadcastId);

    return json({
        success: true,
        sent_count: sent,
        failed_count: failed,
        audience_size: uniq.length,
        audience_reason: reason,
        errors: errors.slice(0, 5),
        from_address: FROM,
        resend_ids: resendIds.slice(0, 5),
    });
});
