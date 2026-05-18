// =============================================================================
// LYMX Power — Feedback Reply Endpoint
// =============================================================================
// POST /functions/v1/feedback-reply
//
// Admin/staff posts a reply to a feedback thread. Optionally asks the
// submitter to verify a fix (mints one-time-use verification_token, sends
// email with Confirm/Still-broken buttons).
//
// REQUEST BODY:
//   {
//     "feedback_id": "uuid",
//     "body_text": "Hey, fixed in commit X. Check it out.",
//     "asks_verification": true,
//     "set_status": "in_progress"      // optional: also update feedback status
//   }
//
// AUTH: caller must be admin OR have a staff role of support/tech.
//
// RESPONSE (200):
//   { success: true, reply_id, email_sent, verification_token }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const errorResponse = (msg, status = 400) => json({ error: msg }, status);

function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

function wrapEmail(opts) {
    const verifyButtons = opts.verifyLinks
        ? '<table style="margin:20px 0"><tr>' +
          '<td style="padding-right:10px"><a href="' + opts.verifyLinks.confirm + '" style="background:#13a26b;color:#fff;padding:11px 22px;border-radius:9px;font-weight:700;text-decoration:none;font-size:14px;display:inline-block">✓ Yes, it works</a></td>' +
          '<td><a href="' + opts.verifyLinks.still + '" style="background:#fff;color:#9b1c1c;border:1px solid #f5b7b7;padding:11px 22px;border-radius:9px;font-weight:700;text-decoration:none;font-size:14px;display:inline-block">✗ Still broken</a></td>' +
          '</tr></table>' +
          '<div style="font-size:12px;color:#5b6472;margin-top:6px">No login needed — these buttons work from this email.</div>'
        : "";

    return '<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;color:#0e1116;background:#f6f7f9;padding:24px">' +
        '<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;padding:28px 32px;box-shadow:0 6px 24px rgba(14,17,22,.08)">' +
            '<div style="font-size:20px;font-weight:800;color:#0e1116;margin-bottom:6px">Re: your feedback</div>' +
            (opts.originalSubject ? '<div style="font-size:13px;color:#5b6472;margin-bottom:14px">' + escapeHtml(opts.originalSubject) + '</div>' : '') +
            (opts.originalMessage ? '<div style="background:#f6f7f9;border-left:3px solid #d1d5db;padding:10px 14px;border-radius:6px;font-size:13px;color:#5b6472;margin-bottom:16px;font-style:italic">You wrote: "' + escapeHtml(opts.originalMessage.slice(0, 200)) + (opts.originalMessage.length > 200 ? '…' : '') + '"</div>' : '') +
            '<div style="background:#e6f5ee;border-left:3px solid #13a26b;padding:14px 16px;border-radius:6px;font-size:15px;line-height:1.55;color:#0e1116;margin-bottom:10px">' +
                escapeHtml(opts.replyBody).replace(/\n/g, '<br>') +
                '<div style="font-size:11.5px;color:#5b6472;margin-top:10px">— ' + escapeHtml(opts.authorName) + '</div>' +
            '</div>' +
            verifyButtons +
            '<hr style="border:0;border-top:1px solid #e6e8ec;margin:24px 0 14px" />' +
            '<div style="font-size:12px;color:#5b6472">' +
                'View your full feedback history: <a href="' + opts.siteUrl + '/my-feedback.html?id=' + opts.feedbackId + '" style="color:#0050c7">My feedback on LYMX</a><br>' +
                'This message is private to you.' +
            '</div>' +
        '</div></body></html>';
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return errorResponse("Method not allowed", 405);

    // Parse + auth
    let body;
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON", 400); }
    const { feedback_id, body_text, asks_verification, set_status } = body || {};
    if (!feedback_id || !body_text) return errorResponse("Missing feedback_id or body_text", 400);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return errorResponse("Missing Authorization", 401);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(SUPABASE_URL, SVC);

    // Verify user + role
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return errorResponse("Unauthorized", 401);

    const { data: staff } = await supabase.from("staff_roles").select("role").eq("user_id", user.id).maybeSingle();
    if (!staff) return errorResponse("Staff role required to reply", 403);

    // Load feedback
    const { data: fb, error: fbErr } = await supabase.from("feedback").select("*").eq("id", feedback_id).single();
    if (fbErr || !fb) return errorResponse("Feedback not found", 404);

    // Mint verification token if requested
    let token = null;
    if (asks_verification) {
        token = crypto.randomUUID();
    }

    // Insert the reply
    const { data: reply, error: replyErr } = await supabase.from("feedback_replies").insert({
        feedback_id,
        author_id: user.id,
        author_name: user.user_metadata?.full_name || user.email,
        author_email: user.email,
        author_role: staff.role,
        kind: "admin_response",
        body_text,
        asks_verification: !!asks_verification,
    }).select().single();
    if (replyErr) return errorResponse("Reply insert failed: " + replyErr.message, 500);

    // Update feedback (token, status, awaiting flag)
    const fbUpdate = {};
    if (asks_verification) {
        fbUpdate.verification_token = token;
        fbUpdate.awaiting_verification = true;
    }
    if (set_status) fbUpdate.status = set_status;
    if (Object.keys(fbUpdate).length) {
        await supabase.from("feedback").update(fbUpdate).eq("id", feedback_id);
    }

    // Send email to submitter if we have their email
    let emailSent = false;
    if (fb.user_email) {
        const RESEND = Deno.env.get("RESEND_API_KEY");
        const FROM   = Deno.env.get("EMAIL_FROM") || "LYMX Support <hello@getlymx.com>";
        const SITE   = Deno.env.get("LYMX_SITE_URL") || "https://getlymx.com";

        if (RESEND) {
            const verifyLinks = token ? {
                confirm: SITE + "/verify-fix.html?fid=" + feedback_id + "&token=" + token + "&action=confirm",
                still:   SITE + "/verify-fix.html?fid=" + feedback_id + "&token=" + token + "&action=still",
            } : null;

            // ----- Locale-aware: translate the reply body if the submitter
            // has a preferred_locale that's not English. -----
            let translatedReply = body_text;
            let translatedSubjectFragment = (fb.subject || fb.message || "").slice(0, 60);
            let recipientLocale = "en";
            if (fb.user_id) {
                try {
                    const { data: locData } = await supabase.rpc("fn_resolve_recipient_locale", { p_user_id: fb.user_id });
                    if (locData && ["en","es","zh-CN","zh-TW","ko","ja"].includes(locData)) recipientLocale = locData;
                } catch {}
            }
            if (recipientLocale !== "en") {
                try {
                    const SB_URL_VAL = Deno.env.get("SUPABASE_URL");
                    const ANON_VAL = Deno.env.get("SUPABASE_ANON_KEY");
                    const tx = async (text, ctx) => {
                        const r = await fetch(SB_URL_VAL + "/functions/v1/translate-text", {
                            method: "POST",
                            headers: { "Content-Type": "application/json", "apikey": ANON_VAL, "Authorization": "Bearer " + ANON_VAL },
                            body: JSON.stringify({ text, target_locale: recipientLocale, source_locale: "en", context: ctx }),
                        });
                        if (!r.ok) return text;
                        const j = await r.json();
                        return j.ok ? (j.translated_text || text) : text;
                    };
                    translatedReply = await tx(body_text, "customer-support reply from a small rewards platform; warm professional tone");
                    if (translatedSubjectFragment) {
                        translatedSubjectFragment = await tx(translatedSubjectFragment, "email subject fragment");
                    }
                } catch {}
            }

            const html = wrapEmail({
                feedbackId: feedback_id,
                originalSubject: fb.subject || "Your feedback",
                originalMessage: fb.message,
                replyBody: translatedReply,
                authorName: user.user_metadata?.full_name || user.email,
                verifyLinks,
                siteUrl: SITE,
            });

            const reSubject = recipientLocale === "es" ? "Re: tu " :
                              recipientLocale === "zh-CN" ? "回复: 您的" :
                              recipientLocale === "zh-TW" ? "回覆: 您的" :
                              recipientLocale === "ko" ? "회신: 귀하의 " :
                              recipientLocale === "ja" ? "返信: " :
                              "Re: your ";
            const subjectLine = reSubject + (fb.type || "feedback") + " — " + translatedSubjectFragment;

            try {
                const sendRes = await fetch("https://api.resend.com/emails", {
                    method: "POST",
                    headers: { "Authorization": "Bearer " + RESEND, "Content-Type": "application/json" },
                    body: JSON.stringify({ from: FROM, to: [fb.user_email], subject: subjectLine, html }),
                });
                if (sendRes.ok) {
                    emailSent = true;
                    const sendJson = await sendRes.json().catch(() => ({}));
                    await supabase.from("feedback_replies").update({
                        email_sent_at: new Date().toISOString(),
                        email_message_id: sendJson.id || null,
                    }).eq("id", reply.id);
                    await supabase.from("feedback").update({ submitter_notified_at: new Date().toISOString() }).eq("id", feedback_id);
                }
            } catch (e) {
                console.warn("Email send failed:", e.message);
            }
        }
    }

    return json({
        success: true,
        reply_id: reply.id,
        email_sent: emailSent,
        verification_token: token,
    });
});
