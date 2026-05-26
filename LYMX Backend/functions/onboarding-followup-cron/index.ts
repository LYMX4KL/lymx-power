// =============================================================================
// LYMX Power — Onboarding Follow-up Cron (Module 3)
// =============================================================================
// POST /functions/v1/onboarding-followup-cron
//
// Finds approved businesses that have not yet booked their 20-minute
// onboarding call (Module 3, migration 096 — v_unbooked_approved_businesses)
// and sends them a nudge email. Throttled so the same biz won't get more
// than one nudge in any 7-day window, and capped at 3 total nudges before
// escalating to a manual admin review.
//
// REQUEST BODY:
//   { "min_days_since_approval": 3 }   // optional, default 3
//   { "dry_run": true }                // optional, default false — when true,
//                                       returns the list it WOULD email without
//                                       actually sending.
//
// AUTH:
//   - service_role JWT bypasses the admin gate (for pg_cron / external scheduler)
//   - authenticated admin (am_i_admin returns true) — for manual trigger from
//     an "Run nudge cron now" button in the admin UI
//
// RESPONSE (200):
//   {
//     "success": true,
//     "evaluated": 5,
//     "nudged": 2,
//     "skipped_throttled": 2,
//     "skipped_cap_hit": 1,
//     "details": [ { biz_id, slug, sent, reason }, ... ]
//   }
//
// SCHEDULING:
//   Configure a pg_cron entry in Supabase Database → Cron Jobs:
//     SELECT cron.schedule(
//       'onboarding-followup-nudge',
//       '0 14 * * *',   -- 2pm UTC daily ≈ 7am Pacific
//       $$ SELECT net.http_post(
//              url := 'https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/onboarding-followup-cron',
//              headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>', 'Content-Type', 'application/json'),
//              body := '{}'::jsonb
//          ) $$
//     );
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const errorResponse = (m: string, s = 400) => json({ error: m }, s);

const NUDGE_THROTTLE_DAYS = 7;
const NUDGE_MAX_TOTAL     = 3;

function jwtRoleAndUser(authHeader: string | null): { userId: string | null; isServiceRole: boolean } {
    if (!authHeader) return { userId: null, isServiceRole: false };
    const tok = authHeader.replace(/^Bearer\s+/i, "").trim();
    const parts = tok.split(".");
    if (parts.length !== 3) return { userId: null, isServiceRole: false };
    try {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        return { userId: payload.sub || null, isServiceRole: payload.role === "service_role" };
    } catch { return { userId: null, isServiceRole: false }; }
}

function escHtml(s: string): string {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    } as Record<string, string>)[c]);
}

function nudgeTemplate(args: {
    business_name: string;
    days_since_approval: number;
    booking_url: string;
    nudge_number: number;
}): { subject: string; html: string } {
    // Tone escalates gently from 1 → 2 → 3.
    let subject: string;
    let lede: string;
    if (args.nudge_number === 1) {
        subject = `Quick reminder: book your LYMX onboarding call for ${args.business_name}`;
        lede = `It's been ${args.days_since_approval} days since we approved <strong>${escHtml(args.business_name)}</strong> on LYMX. Your 20-minute onboarding call with the team is the one thing standing between you and your first reward issuance — most businesses are done within the call itself.`;
    } else if (args.nudge_number === 2) {
        subject = `Still need to book your LYMX onboarding call — ${args.business_name}`;
        lede = `Friendly second nudge: <strong>${escHtml(args.business_name)}</strong> has been approved for ${args.days_since_approval} days but we haven't seen you book your onboarding call yet. The call is short (20 minutes) but required — once you've done it, you can start issuing rewards immediately.`;
    } else {
        subject = `Final reminder: book your LYMX onboarding call — ${args.business_name}`;
        lede = `One last nudge before we step aside: <strong>${escHtml(args.business_name)}</strong> has been approved for ${args.days_since_approval} days. If now isn't a good time, just reply to this email and we'll pick a different week. If we don't hear from you, we'll archive the application and you can re-apply when ready.`;
    }
    const html = `<p>Hi,</p>

<p>${lede}</p>

<p style="margin:18px 0"><a href="${args.booking_url}" style="display:inline-block;background:#0a84ff;color:#fff;padding:13px 24px;border-radius:9px;font-weight:700;text-decoration:none">Book your 20-min onboarding call →</a></p>

<p style="color:#5b6472;font-size:13px;margin-top:-6px">Or paste this link into your browser:<br><a href="${args.booking_url}">${args.booking_url}</a></p>

<p>Questions? Reply directly to this email and it reaches the LYMX team.</p>

<p>— Kenny Lin<br>
LYMX Power Inc.<br>
<a href="mailto:hello@getlymx.com">hello@getlymx.com</a></p>`;
    return { subject, html };
}

async function sendViaResend(
    to: string, subject: string, html: string, replyTo: string, apiKey: string,
): Promise<{ ok: boolean; error?: string; id?: string }> {
    const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            from: "LYMX <kenny@lymxpower.com>",
            to: [to],
            subject,
            html,
            reply_to: replyTo,
        }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: (body as any).message || `http ${r.status}` };
    return { ok: true, id: (body as any).id };
}

serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST")    return errorResponse("Method not allowed", 405);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const RESEND_KEY   = Deno.env.get("RESEND_API_KEY");
    if (!SUPABASE_URL || !SERVICE_KEY) return errorResponse("Server config missing", 500);
    if (!RESEND_KEY)                   return errorResponse("RESEND_API_KEY not configured", 500);

    // Body params (all optional)
    let bodyParams: any = {};
    try { bodyParams = await req.json().catch(() => ({})); } catch { bodyParams = {}; }
    const minDays  = Number.isInteger(bodyParams.min_days_since_approval) ? bodyParams.min_days_since_approval : 3;
    const dryRun   = bodyParams.dry_run === true;

    // Auth
    const authHeader = req.headers.get("authorization") || "";
    const { userId, isServiceRole } = jwtRoleAndUser(authHeader);
    if (!userId && !isServiceRole) return errorResponse("Authentication required", 401);

    const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    if (!isServiceRole) {
        // Admin gate for manual triggers
        const supaAsUser = createClient(SUPABASE_URL, SERVICE_KEY, {
            auth: { persistSession: false },
            global: { headers: { Authorization: authHeader } },
        });
        const { data: isAdmin } = await supaAsUser.rpc("am_i_admin");
        if (!isAdmin) return errorResponse("Admin only", 403);
    }

    // Query the view
    const { data: candidates, error: qErr } = await supa
        .from("v_unbooked_approved_businesses")
        .select("id, slug, display_name, legal_name, contact_email, owner_user_id, approved_at, days_since_approval, prior_nudges, last_nudge_at")
        .gte("days_since_approval", minDays);
    if (qErr) return errorResponse(`view query failed: ${qErr.message}`, 500);
    if (!candidates || candidates.length === 0) {
        return json({ success: true, evaluated: 0, nudged: 0, skipped_throttled: 0, skipped_cap_hit: 0, details: [] });
    }

    const details: Array<Record<string, unknown>> = [];
    let nudged = 0;
    let throttled = 0;
    let capHit = 0;
    const cutoffMs = Date.now() - (NUDGE_THROTTLE_DAYS * 24 * 60 * 60 * 1000);

    for (const c of candidates) {
        const cAny = c as any;
        const bizId = cAny.id;
        const slug = cAny.slug || "";
        const displayName = cAny.display_name || cAny.legal_name || "your business";
        const toEmail = cAny.contact_email;
        const daysSince = Number(cAny.days_since_approval) || 0;
        const priorNudges = Number(cAny.prior_nudges) || 0;
        const lastNudgeAt = cAny.last_nudge_at ? new Date(cAny.last_nudge_at).getTime() : 0;

        if (!toEmail) {
            details.push({ biz_id: bizId, slug, sent: false, reason: "no_contact_email" });
            continue;
        }

        if (priorNudges >= NUDGE_MAX_TOTAL) {
            capHit++;
            details.push({ biz_id: bizId, slug, sent: false, reason: "cap_reached", prior_nudges: priorNudges });
            continue;
        }

        if (lastNudgeAt && lastNudgeAt > cutoffMs) {
            throttled++;
            details.push({ biz_id: bizId, slug, sent: false, reason: "throttled_7d", last_nudge_at: cAny.last_nudge_at });
            continue;
        }

        const tpl = nudgeTemplate({
            business_name: displayName,
            days_since_approval: daysSince,
            booking_url: `https://getlymx.com/book-onboarding-call.html?biz=${encodeURIComponent(slug)}`,
            nudge_number: priorNudges + 1,
        });

        if (dryRun) {
            details.push({ biz_id: bizId, slug, sent: false, reason: "dry_run", would_send_to: toEmail, subject: tpl.subject, nudge_number: priorNudges + 1 });
            nudged++; // count what we WOULD send
            continue;
        }

        const send = await sendViaResend(toEmail, tpl.subject, tpl.html, "kenny@lymxpower.com", RESEND_KEY);
        if (!send.ok) {
            // Log the failure, don't abort the whole batch.
            await supa.from("onboarding_followup_sends").insert({
                business_id: bizId,
                to_email: toEmail,
                template_key: "onboarding_followup",
                days_since_approval: daysSince,
                error_text: send.error || "send_failed",
            });
            details.push({ biz_id: bizId, slug, sent: false, reason: "resend_error", error: send.error });
            continue;
        }

        // Record success
        await supa.from("onboarding_followup_sends").insert({
            business_id: bizId,
            to_email: toEmail,
            template_key: "onboarding_followup",
            days_since_approval: daysSince,
            resend_message_id: send.id,
        });
        nudged++;
        details.push({
            biz_id: bizId,
            slug,
            sent: true,
            sent_to: toEmail,
            nudge_number: priorNudges + 1,
            resend_message_id: send.id,
        });
    }

    return json({
        success: true,
        dry_run: dryRun,
        evaluated: candidates.length,
        nudged,
        skipped_throttled: throttled,
        skipped_cap_hit: capHit,
        min_days_since_approval: minDays,
        details,
    });
});
