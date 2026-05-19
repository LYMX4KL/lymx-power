// =============================================================================
// LYMX Power — notify-ot-request
// =============================================================================
// POST /functions/v1/notify-ot-request
//
// Called by my-time-off.html (or future my-overtime.html) when staff submit
// an overtime request. Emails every staff_role flagged as is_hr OR is_admin
// with approve/deny deep links, AND opens a conversation thread tied to the
// requesting user so the back-and-forth is captured in admin-conversations.html.
//
// REQUEST BODY:
//   {
//     work_date:            'YYYY-MM-DD',
//     expected_extra_hours: number,
//     reason:               string,
//     covering_task?:       string
//   }
//
// AUTH: authenticated staff user.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const err = (m: string, s = 400) => json({ ok: false, error: m }, s);

function esc(s: unknown): string {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]!));
}

serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return err("Method not allowed", 405);

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SB_URL || !SB_KEY) return err("Server config missing", 500);
    const supa = createClient(SB_URL, SB_KEY);

    // Auth
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return err("Unauthorized", 401);
    const { data: userData, error: userErr } = await supa.auth.getUser(token);
    if (userErr || !userData?.user) return err("Invalid token", 401);
    const requesterId = userData.user.id;

    let body: any;
    try { body = await req.json(); } catch { return err("Bad JSON"); }
    if (!body.work_date) return err("Missing work_date");
    if (!body.expected_extra_hours || Number(body.expected_extra_hours) <= 0) return err("Missing expected_extra_hours");
    if (!body.reason || String(body.reason).trim().length < 5) return err("Reason must be at least 5 characters");

    const extraHrs = Number(body.expected_extra_hours);
    const workDate = String(body.work_date);
    const reason = String(body.reason).trim();
    const coveringTask = body.covering_task ? String(body.covering_task).trim() : null;

    // Pull requester name
    const { data: requesterProf } = await supa.from("staff_profiles")
        .select("full_name, email")
        .eq("user_id", requesterId).maybeSingle();
    const requesterName = requesterProf?.full_name || userData.user.email || "Staff member";
    const requesterEmail = requesterProf?.email || userData.user.email || "(no email)";

    // Pull HR + admin recipients
    const { data: roles } = await supa.from("staff_roles")
        .select("user_id")
        .or("is_hr.eq.true,is_admin.eq.true");
    const userIds = (roles || []).map((r: any) => r.user_id).filter((id: string) => id !== requesterId);
    const recipients: Array<{ email: string; user_id: string }> = [];
    for (const uid of userIds) {
        const { data: u } = await supa.auth.admin.getUserById(uid);
        if (u?.user?.email) recipients.push({ email: u.user.email, user_id: uid });
    }
    if (!recipients.length) {
        return json({ ok: true, notified: 0, reason: "no HR/admin recipients found" });
    }

    // Compose email
    const subject = `OT request: ${requesterName} — +${extraHrs}h on ${workDate}`;
    const approveLink = "https://getlymx.com/admin-conversations.html?with=" + encodeURIComponent(requesterId);

    const htmlBody = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;font-size:14px;line-height:1.55;color:#0e1116;max-width:580px;margin:0 auto;padding:1.5rem">
        <h2 style="margin:0 0 .5rem;font-size:17px">⏰ Overtime request — needs your approval</h2>
        <table style="width:100%;border-collapse:collapse;font-size:13.5px;margin:1rem 0">
            <tr><td style="padding:6px 10px;color:#5b6472;font-weight:600">Requested by</td><td style="padding:6px 10px">${esc(requesterName)} (${esc(requesterEmail)})</td></tr>
            <tr><td style="padding:6px 10px;color:#5b6472;font-weight:600">Work date</td><td style="padding:6px 10px">${esc(workDate)}</td></tr>
            <tr><td style="padding:6px 10px;color:#5b6472;font-weight:600">Extra hours</td><td style="padding:6px 10px"><strong>+${extraHrs}h</strong></td></tr>
            <tr><td style="padding:6px 10px;color:#5b6472;font-weight:600;vertical-align:top">Reason</td><td style="padding:6px 10px">${esc(reason).replace(/\n/g, "<br>")}</td></tr>
            ${coveringTask ? `<tr><td style="padding:6px 10px;color:#5b6472;font-weight:600;vertical-align:top">Covering task</td><td style="padding:6px 10px">${esc(coveringTask)}</td></tr>` : ""}
        </table>
        <p style="margin:1rem 0 .25rem"><a href="${approveLink}" style="display:inline-block;background:#0e1116;color:#fff;padding:9px 18px;border-radius:8px;font-weight:700;text-decoration:none">Open thread to approve/deny →</a></p>
        <p style="margin:1.5rem 0 0;color:#94a3b8;font-size:11.5px">LYMX Power HR · ${new Date().toLocaleDateString()}</p>
    </div>`;

    const textBody = `OT request from ${requesterName}
Work date: ${workDate}
Extra hours: +${extraHrs}h
Reason: ${reason}${coveringTask ? "\nCovering: " + coveringTask : ""}

Open thread to approve/deny: ${approveLink}`;

    // Send emails in parallel
    let sentCount = 0;
    const failures: string[] = [];
    await Promise.all(recipients.map(async r => {
        try {
            const resp = await fetch(SB_URL + "/functions/v1/send-email", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SB_KEY}`, "apikey": SB_KEY },
                body: JSON.stringify({
                    channel: "outreach",
                    recipient_email: r.email,
                    subject,
                    body_text: textBody,
                    body_html: htmlBody,
                    template_key: "ot_request_notify",
                }),
            });
            if (resp.ok) sentCount++;
            else failures.push(r.email + ":" + resp.status);
        } catch (e) {
            failures.push(r.email + ":exception");
            console.warn("send-email failed", r.email, e);
        }
    }));

    // Open / append a conversation thread (best-effort, swallow errors so the EF doesn't fail if conversations table is missing)
    try {
        await fetch(SB_URL + "/functions/v1/conversation-send-message", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SB_KEY}`, "apikey": SB_KEY },
            body: JSON.stringify({
                participant_user_id: requesterId,
                kind: "ot_request",
                subject: `OT request — ${workDate} (+${extraHrs}h)`,
                body: `${requesterName} requested +${extraHrs}h on ${workDate}.\n\nReason:\n${reason}${coveringTask ? "\n\nCovering task: " + coveringTask : ""}`,
                from_system: true,
            }),
        });
    } catch (e) {
        console.warn("conversation-send-message failed (non-fatal)", e);
    }

    return json({ ok: true, notified: sentCount, failures: failures.slice(0, 10) });
});
