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
    return {
        subject: `Your LYMX Business is live — ${displayName}`,
        html: `<p>Hi,</p>

<p>Good news: <strong>${displayName}</strong> is now live on the LYMX network.</p>

<h3>What to do next</h3>

<p><strong>1) Sign in to your business dashboard:</strong><br>
<a href="${dashboardUrl}">${dashboardUrl}</a></p>

<p>You'll see your KPIs, recent customer transactions, settlements, and your public listing. Right now most numbers will show "—" because no LYMX has flowed yet. That changes the moment you start issuing rewards.</p>

<p><strong>2) Share your customer landing URL:</strong><br>
<a href="${welcomeUrl}">${welcomeUrl}</a></p>

<p>Drop that link in your newsletter, on your storefront QR code, in your email signature — anywhere customers can click. The first 25 customers who sign up via that URL get <strong>150 LYMX</strong> (100 from LYMX + 50 from you, billed at $0.50 per customer).</p>

<p><strong>3) Book a 1-on-1 with Rachel</strong> if you want a live walkthrough:<br>
<a href="https://getlymx.com/book-onboarding-call.html">getlymx.com/book-onboarding-call.html</a></p>

<p>She'll spend 30 minutes with you, answer questions, and help you set up your first promotion.</p>

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
        .select("id, slug, display_name, legal_name, contact_email, owner_user_id")
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
        const dashboardUrl = "https://getlymx.com/biz-dashboard.html";
        const welcomeUrl = `https://getlymx.com/welcome.html?biz=${encodeURIComponent(slug)}`;
        composed = approvedEmail(displayName, slug, dashboardUrl, welcomeUrl);
    } else {
        const reason = body.rejection_reason?.trim() || "Application could not be approved at this time.";
        composed = rejectedEmail(displayName, reason);
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

    return json({ success: true, sent_to: toEmail, subject: composed.subject });
});
