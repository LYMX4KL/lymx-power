// =============================================================================
// LYMX Power — Feedback User Reply Endpoint
// =============================================================================
// POST /functions/v1/feedback-user-reply
//
// Submitter posts a follow-up reply to their own feedback thread. This is the
// USER-side equivalent of `feedback-reply` (which is admin-only). Use cases:
//  - User clarifies their bug report after we ask a question
//  - User adds new info after a fix didn't fully work (but wants to keep the
//    thread open instead of using "Still broken" which is a hard verification)
//  - User confirms gratefulness / closes the loop without a verification token
//
// REQUEST BODY:
//   { feedback_id: "uuid", body_text: "..." }
//
// AUTH: caller must be the original submitter (auth.uid() === feedback.user_id).
//
// SIDE EFFECTS:
//   1. Inserts feedback_replies row with kind='submitter_response'
//   2. Transitions parent feedback row:
//      - awaiting_verification: true → false   (user clarified instead of verifying)
//      - status: resolved → in_progress        (auto-reopen when user replies)
//      - status: new → in_progress             (admin should pick this up)
//   3. Bumps reply_count + last_reply_at + last_reply_kind on parent
//   4. Fire-and-forget email to the assigned admin (if any) so they see
//      the new reply in their inbox, not just on the admin page
//
// RESPONSE (200):
//   { success: true, reply_id, status_after }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const errorResponse = (msg: string, status = 400) => json({ error: msg }, status);

function escapeHtml(s: string) {
    return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] as string));
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return errorResponse("Method not allowed", 405);

    let body: { feedback_id?: string; body_text?: string };
    try { body = await req.json(); } catch { return errorResponse("Invalid JSON", 400); }
    const { feedback_id, body_text } = body || {};
    if (!feedback_id || !body_text) return errorResponse("Missing feedback_id or body_text", 400);
    if (body_text.length > 5000) return errorResponse("Reply too long (max 5000 chars)", 400);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return errorResponse("Missing Authorization", 401);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Verify caller identity via their token
    const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return errorResponse("Auth failed", 401);
    const userId = userData.user.id;
    const userEmail = userData.user.email || null;
    const userName = (userData.user.user_metadata?.first_name as string) || (userData.user.email?.split("@")[0]) || "Customer";

    // Service client for the writes (bypasses RLS but we re-check ownership)
    const svc = createClient(SUPABASE_URL, SVC_KEY);

    // Fetch parent feedback row + verify ownership
    const { data: fb, error: fbErr } = await svc
        .from("feedback")
        .select("id, user_id, user_email, subject, status, awaiting_verification, assigned_to, reply_count")
        .eq("id", feedback_id)
        .maybeSingle();
    if (fbErr || !fb) return errorResponse("Ticket not found", 404);

    // Ownership check: either auth.uid() matches OR (for legacy anon submissions)
    // the email matches. The email path is a soft fallback for older tickets.
    const ownerByUid = fb.user_id && fb.user_id === userId;
    const ownerByEmail = !fb.user_id && fb.user_email && userEmail && fb.user_email.toLowerCase() === userEmail.toLowerCase();
    if (!ownerByUid && !ownerByEmail) {
        return errorResponse("You can only reply to your own tickets", 403);
    }

    // Insert the reply
    const { data: replyRow, error: replyErr } = await svc
        .from("feedback_replies")
        .insert({
            feedback_id,
            author_id: userId,
            author_name: userName,
            author_email: userEmail,
            author_role: "customer",
            kind: "submitter_response",
            body_text: body_text.trim(),
            asks_verification: false,
        })
        .select("id")
        .single();
    if (replyErr) {
        console.error("feedback_replies insert failed:", replyErr.message);
        return errorResponse("Could not save your reply: " + replyErr.message, 500);
    }

    // Transition the parent feedback row:
    //  - awaiting_verification → false (the user typed a free reply instead of confirming)
    //  - resolved → in_progress (auto-reopen because the user wants to continue the thread)
    //  - new → in_progress (admin should look at this)
    const nextStatus =
        fb.status === "resolved" ? "in_progress" :
        fb.status === "new" ? "in_progress" :
        fb.status; // closed/spam stay where they are

    const { error: updateErr } = await svc
        .from("feedback")
        .update({
            awaiting_verification: false,
            status: nextStatus,
            reply_count: (fb.reply_count || 0) + 1,
            last_reply_at: new Date().toISOString(),
            last_reply_kind: "submitter_response",
        })
        .eq("id", feedback_id);
    if (updateErr) console.warn("feedback parent update failed (non-fatal):", updateErr.message);

    // Fire-and-forget: email the assigned admin (or admin@lymxpower.com fallback)
    if (fb.assigned_to) {
        try {
            const { data: adminUser } = await svc.auth.admin.getUserById(fb.assigned_to);
            const adminEmail = adminUser?.user?.email;
            if (adminEmail) {
                const subject = "Re: " + (fb.subject || "your ticket") + " — submitter replied";
                const bodyHtml = '<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:20px;color:#0e1116">'
                    + '<h2 style="margin:0 0 8px;font-size:18px">Submitter replied to <code style="font-size:14px;background:#f6f7f9;padding:2px 6px;border-radius:4px">#' + feedback_id.slice(0, 8) + '</code></h2>'
                    + '<p style="color:#5b6472;font-size:13px;margin:0 0 16px">From: ' + escapeHtml(userName) + ' &lt;' + escapeHtml(userEmail || "") + '&gt;</p>'
                    + '<div style="background:#eef5ff;border-left:3px solid #0a84ff;padding:14px 16px;border-radius:6px;font-size:14px;line-height:1.55;white-space:pre-wrap">' + escapeHtml(body_text) + '</div>'
                    + '<p style="margin-top:18px"><a href="https://getlymx.com/admin-tech-support.html?id=' + feedback_id + '" style="background:#0e1116;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13.5px">Open ticket →</a></p>'
                    + "</div>";
                // Fire and forget
                fetch(SUPABASE_URL + "/functions/v1/send-email", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: "Bearer " + SVC_KEY, apikey: SVC_KEY },
                    body: JSON.stringify({
                        channel: "transactional",
                        recipient_email: adminEmail,
                        subject,
                        body_text: "Submitter replied to ticket #" + feedback_id.slice(0, 8) + ":\n\n" + body_text + "\n\nOpen: https://getlymx.com/admin-tech-support.html?id=" + feedback_id,
                        body_html: bodyHtml,
                        template_key: "feedback_user_reply_notif",
                    }),
                }).catch(() => { /* best effort */ });
            }
        } catch (e) {
            console.warn("admin notify failed (non-fatal):", e);
        }
    }

    return json({ success: true, reply_id: replyRow.id, status_after: nextStatus });
});
