// =============================================================================
// LYMX Power — Business Approval Email
// =============================================================================
// POST /functions/v1/business-approval-email
//
// Sends an email to a business owner when their LYMX Business application is
// approved or rejected. Called by admin-business-applications.html right
// after PATCH to public.businesses succeeds.
//
// REQUEST BODY:
//   { "business_id": "uuid", "status": "approved" | "rejected",
//     "rejection_reason": "optional string for rejected" }
//
// AUTH: caller must be admin (am_i_admin() = true).
//
// RESPONSE (200):
//   { "success": true, "sent_to": "owner@example.com", "subject": "..." }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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

function userFromJwt(authHeader: string | null): string | null {
    if (!authHeader) return null;
    const tok = authHeader.replace(/^Bearer\s+/i, "").trim();
    const parts = tok.split(".");
    if (parts.length !== 3) return null;
    try {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        return payload.sub || null;
    } catch {
        return null;
    }
}

function approvedEmail(displayName: string, slug: string, dashboardUrl: string, welcomeUrl: string): { subject: string; html: string } {
    // Module 3 / migration 096: per-biz booking URL so Rachel sees the biz
    // context when the booking row arrives. The page consumes ?biz=<slug>,
    // prefills the form, and links the resulting booking to businesses.id.
    const bookCallUrl = `https://getlymx.com/book-onboarding-call.html?biz=${encodeURIComponent(slug)}`;
    return {
        subject: `Your LYMX Business is live — ${displayName} (next step: book your 20-min onboarding call)`,
        html: `<p>Hi,</p>

<p>Good news: <strong>${displayName}</strong> is now live on the LYMX network.</p>

<p style="background:#fff8e6;border-left:4px solid #f0a020;padding:12px 16px;border-radius:0 8px 8px 0;margin:18px 0"><strong>One required next step:</strong> book your free 20-minute onboarding call below. We need this call before you start issuing rewards — it's how we confirm your POS setup, walk you through the dashboard, and make sure your first transaction works. Most businesses are done in under 20 minutes.</p>

<p style="margin:18px 0"><a href="${bookCallUrl}" style="display:inline-block;background:#0a84ff;color:#fff;padding:13px 24px;border-radius:9px;font-weight:700;text-decoration:none">Book your 20-min onboarding call →</a></p>

<p style="color:#5b6472;font-size:13px;margin-top:-6px">Or paste this link into your browser:<br><a href="${bookCallUrl}">${bookCallUrl}</a></p>

<h3>While you wait for your call</h3>

<p><strong>1) Sign in to your business dashboard:</strong><br>
<a href="${dashboardUrl}">${dashboardUrl}</a></p>

<p>You'll see your KPIs, recent customer transactions, settlements, and your public listing. Right now most numbers will show "—" because no LYMX has flowed yet. That changes the moment you start issuing rewards.</p>

<p><strong>2) Share your customer landing URL:</strong><br>
<a href="${welcomeUrl}">${welcomeUrl}</a></p>

<p>Drop that link in your newsletter, on your storefront QR code, in your email signature — anywhere customers can click. The first 25 customers who sign up via that URL get <strong>150 LYMX</strong> (100 from LYMX + 50 from you, billed at $0.50 per customer).</p>

<h3>Your plan</h3>
<p>3 months free — your first invoice is on the 1st of the 4th month. $199/mo after that. You can cancel any time. See full terms at <a href="https://getlymx.com/biz-tos.html">getlymx.com/biz-tos.html</a>.</p>

<p>Welcome to LYMX.</p>

<p>— Kenny Lin<br>
LYMX Power Inc.<br>
<a href="mailto:hello@getlymx.com">hello@getlymx.com</a></p>`,
    };
}

function rejectedEmail(displayName: string, reason: string): { subject: string; html: string } {
    return {
        subject: `Your LYMX Business application — next steps`,
        html: `<p>Hi,</p>

<p>Thanks for applying to bring <strong>${displayName}</strong> onto the LYMX network. After reviewing your application, we're not able to approve it today.</p>

<h3>Reason</h3>
<p style="background:#fff8e6;border-left:4px solid #f0a020;padding:10px 14px;border-radius:6px">${reason}</p>

<h3>What you can do</h3>
<ul>
  <li><strong>Reply to this email</strong> with the requested info — most applications get re-reviewed and approved within 24 hours.</li>
  <li><strong>Book a 1-on-1 call with Rachel</strong> (our onboarding lead): <a href="https://getlymx.com/book-onboarding-call.html">getlymx.com/book-onboarding-call.html</a></li>
</ul>

<p>If this is a misunderstanding, we'd rather fix it than lose you. Hit reply.</p>

<p>— Kenny Lin<br>
LYMX Power Inc.<br>
<a href="mailto:hello@getlymx.com">hello@getlymx.com</a></p>`,
    };
}

async function sendViaResend(to: string, subject: string, html: string, apiKey: string): Promise<{ ok: boolean; error?: string; id?: string }> {
    const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            from: "LYMX <kenny@lymxpower.com>",
            to: [to],
            subject,
            html,
            reply_to: "kenny@lymxpower.com",
        }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: body.message || `http ${r.status}` };
    return { ok: true, id: body.id };
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return errorResponse("Method not allowed", 405);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!supabaseUrl || !serviceKey) return errorResponse("Server config missing", 500);
    if (!resendKey) return errorResponse("RESEND_API_KEY not configured", 500);

    const supabase = createClient(supabaseUrl, serviceKey);

    // Admin gate
    const callerId = userFromJwt(req.headers.get("Authorization"));
    if (!callerId) return errorResponse("Unauthorized", 401);
    const { data: isAdmin, error: aErr } = await supabase.rpc("am_i_admin");
    // Note: am_i_admin() reads auth.uid() — for service-role calls we have to check differently.
    // Fall back: check staff_roles directly.
    const { data: staff } = await supabase.from("staff_roles")
        .select("role").eq("user_id", callerId).eq("role", "admin").maybeSingle();
    if (!staff && !isAdmin) return errorResponse("Admin only", 403);

    // Parse body
    let body: { business_id?: string; status?: string; rejection_reason?: string };
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON", 400); }
    if (!body.business_id) return errorResponse("Missing business_id", 400);
    if (!body.status || !["approved", "rejected"].includes(body.status)) {
        return errorResponse("status must be 'approved' or 'rejected'", 400);
    }

    // Load the business + owner email
    const { data: biz, error: bErr } = await supabase
        .from("businesses")
        .select("id, slug, display_name, legal_name, contact_email, owner_user_id, signed_up_by_partner_id")
        .eq("id", body.business_id)
        .maybeSingle();
    if (bErr || !biz) return errorResponse("Business not found", 404);

    const displayName = biz.display_name || biz.legal_name || "your business";
    let toEmail = biz.contact_email;

    // If the business has an owner_user_id, prefer the auth.users email (the account they sign in with)
    if (biz.owner_user_id) {
        const { data: u } = await supabase.auth.admin.getUserById(biz.owner_user_id);
        if (u?.user?.email) toEmail = u.user.email;
    }
    if (!toEmail) return errorResponse("No contact email on file for this business", 400);

    let composed: { subject: string; html: string };
    if (body.status === "approved") {
        const slug = biz.slug || "";
        // Try to generate a magic-link so the owner clicks the email and lands
        // signed in. Falls back to the plain dashboard URL if generation fails
        // (e.g., owner_user_id is null because the auth user wasn't auto-created).
        let dashboardUrl = "https://getlymx.com/biz-dashboard.html";
        if (biz.owner_user_id && toEmail) {
            try {
                const { data: link } = await supabase.auth.admin.generateLink({
                    type: "magiclink",
                    email: toEmail,
                    options: { redirectTo: "https://getlymx.com/biz-dashboard.html" },
                });
                const actionUrl = (link?.properties as Record<string, string> | undefined)?.action_link;
                if (actionUrl) dashboardUrl = actionUrl;
            } catch (e) { console.warn('[business-approval-email:196] tracking-link build failed, falling back to plain dashboardUrl:', (e as Error).message); }
        }
        const welcomeUrl = `https://getlymx.com/welcome.html?biz=${encodeURIComponent(slug)}`;
        composed = approvedEmail(displayName, slug, dashboardUrl, welcomeUrl);
    } else {
        const reason = body.rejection_reason?.trim() || "Application could not be approved at this time.";
        composed = rejectedEmail(displayName, reason);
    }

    // ----- Locale-aware translation -----
    // Resolve the recipient's preferred_locale (NULL = default English).
    let recipientLocale = "en";
    if (biz.owner_user_id) {
        try {
            const { data: locData } = await supabase.rpc("fn_resolve_recipient_locale", { p_user_id: biz.owner_user_id });
            if (locData && ["en","es","zh-CN","zh-TW","ko","ja"].includes(locData as string)) recipientLocale = locData as string;
        } catch { /* fall back to en */ }
    }
    if (recipientLocale !== "en") {
        try {
            const SB_URL_VAL = Deno.env.get("SUPABASE_URL")!;
            const ANON_VAL = Deno.env.get("SUPABASE_ANON_KEY")!;
            const tx = async (text: string, ctx: string) => {
                const r = await fetch(SB_URL_VAL + "/functions/v1/translate-text", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "apikey": ANON_VAL, "Authorization": `Bearer ${ANON_VAL}` },
                    body: JSON.stringify({ text, target_locale: recipientLocale, source_locale: "en", context: ctx }),
                });
                if (!r.ok) return text;
                const j = await r.json();
                return j.ok ? (j.translated_text || text) : text;
            };
            const newSubject = await tx(composed.subject, "transactional email subject for a business approval/rejection notification");
            // For HTML body we translate text content but keep markup. Simplest path: strip tags, translate, re-wrap minimal HTML.
            const textOnly = composed.html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
            const newText = await tx(textOnly, "transactional email body from a small rewards platform; preserve tone, URLs, and any numbers/amounts as-is");
            const newHtml = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#0e1116;max-width:600px;margin:0 auto;padding:20px;white-space:pre-wrap">${newText.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/(https?:\/\/[^\s]+)/g,'<a href="$1" style="color:#0a84ff">$1</a>').replace(/\n/g,"<br>")}</div>`;
            composed = { subject: newSubject, html: newHtml };
        } catch (e) { console.warn('[business-approval-email:234] translation failed, keeping English:', (e as Error).message); }
    }

    const sent = await sendViaResend(toEmail, composed.subject, composed.html, resendKey);
    if (!sent.ok) return errorResponse(`Email send failed: ${sent.error}`, 502);

    // Log it (best-effort, don't fail the response)
    await supabase.from("email_events").insert({
        recipient_email: toEmail,
        subject: composed.subject,
        kind: body.status === "approved" ? "biz_approved" : "biz_rejected",
        related_id: biz.id,
        provider_msg_id: sent.id,
        sent_at: new Date().toISOString(),
    }).then(() => {}, () => {});

    // 2026-05-20 #8ae35834 - When admin APPROVES a partner-referred business,
    // notify the sponsor partner that their $500 just went live. Non-blocking;
    // failure does NOT roll back the business-owner email.
    if (body.status === "approved" && biz.signed_up_by_partner_id) {
        try {
            const { data: sponsor } = await supabase
                .from("partners")
                .select("legal_name, display_name, contact_email, partner_code")
                .eq("id", biz.signed_up_by_partner_id)
                .maybeSingle();
            if (sponsor && sponsor.contact_email) {
                const firstName = (sponsor.display_name || sponsor.legal_name || "Partner").split(/\s+/)[0];
                const bizLabel = biz.display_name || biz.legal_name || "your referred Business";
                const subj = "$500 just landed - " + bizLabel + " is approved";
                const bodyText = "Hi " + firstName + ",\n\n" +
                    bizLabel + " is now LIVE on LYMX, and your $500 activation bonus has been posted to your commission ledger.\n\n" +
                    "You can see the activation on your Partner Dashboard:\n" +
                    "https://getlymx.com/rep-dashboard.html#myActivationsCard\n\n" +
                    "That's your first (or next) Founding 25 credit - keep them coming. Your local list is the asset; every Business you bring on compounds the network density Businesses care about.\n\n" +
                    "- The LYMX team";
                await fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/send-email", {
                    method: "POST",
                    headers: {
                        "Authorization": "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        recipient_email: sponsor.contact_email,
                        subject: subj,
                        body_text: bodyText,
                        kind: "partner_activation_approved",
                        channel: "transactional",
                    }),
                });
            }
        } catch (sponsorErr) {
            console.warn("Sponsor approval notification failed (non-fatal):", (sponsorErr as Error).message);
        }
    }

    return json({ success: true, sent_to: toEmail, subject: composed.subject });
});
