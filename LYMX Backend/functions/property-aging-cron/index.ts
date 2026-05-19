// =============================================================================
// LYMX Power — property-aging-cron  (cron Monday 14:00 UTC = 06:00 PT)
// =============================================================================
// POST /functions/v1/property-aging-cron
//
// Reads outstanding_property_queue, groups items by age band
// (30-59d / 60-89d / 90+d), composes a weekly summary email, sends to
// every staff_role with is_hr OR is_admin via send-email (channel="outreach"
// — internal HR comms).
//
// Items aged 90+ get flagged in the body as "ELIGIBLE FOR WRITE-OFF" with a
// deep-link to admin-outstanding-property.html.
//
// AUTH: relies on Supabase Functions JWT verification (service-role token from pg_cron).
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

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SB_URL || !SB_KEY) return err("Server config missing", 500);
    const supa = createClient(SB_URL, SB_KEY);

    // Fetch outstanding queue
    const { data: items, error } = await supa.from("outstanding_property_queue").select("*");
    if (error) return err("queue query failed: " + error.message, 500);
    const queue = items || [];

    if (!queue.length) {
        return json({ ok: true, items: 0, sent_to: 0, reason: "queue empty — no email needed" });
    }

    // Bucket by age band
    const band30 = queue.filter((i: any) => (i.days_outstanding || 0) >= 30 && (i.days_outstanding || 0) < 60);
    const band60 = queue.filter((i: any) => (i.days_outstanding || 0) >= 60 && (i.days_outstanding || 0) < 90);
    const band90 = queue.filter((i: any) => (i.days_outstanding || 0) >= 90);
    const totalValAtRisk = queue.reduce((s: number, i: any) => s + Number(i.estimated_value_usd || 0), 0);

    if (!band30.length && !band60.length && !band90.length) {
        // Everything is under 30 days — no nag this week
        return json({ ok: true, items: queue.length, sent_to: 0, reason: "no items past 30 days" });
    }

    // Pull HR + admin recipients from staff_roles
    const { data: roles, error: rErr } = await supa.from("staff_roles")
        .select("user_id, is_hr, is_admin")
        .or("is_hr.eq.true,is_admin.eq.true");
    if (rErr) return err("roles query failed: " + rErr.message, 500);
    const userIds = (roles || []).map((r: any) => r.user_id);
    if (!userIds.length) return json({ ok: true, items: queue.length, sent_to: 0, reason: "no HR/admin recipients" });

    // Get their emails
    const recipients: Array<{ email: string; name: string }> = [];
    for (const uid of userIds) {
        const { data: u } = await supa.auth.admin.getUserById(uid);
        if (u?.user?.email) recipients.push({ email: u.user.email, name: u.user.user_metadata?.full_name || u.user.email });
    }
    if (!recipients.length) return json({ ok: true, items: queue.length, sent_to: 0, reason: "recipients had no email" });

    // Compose body
    const subject = `LYMX HR weekly: ${queue.length} outstanding propert${queue.length === 1 ? "y item" : "y items"} · $${totalValAtRisk.toFixed(0)} at risk`;
    const linkBase = "https://getlymx.com/admin-outstanding-property.html";

    function row(i: any): string {
        return `<tr>
            <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(i.label)}<div style="font-size:11px;color:#888">${esc(i.category || "")}</div></td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(i.holder_name || (i.profile_id || "").slice(0, 8))}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${i.days_outstanding}d</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">$${Number(i.estimated_value_usd || 0).toFixed(0)}</td>
        </tr>`;
    }

    function section(title: string, items: any[], color: string): string {
        if (!items.length) return "";
        return `<h3 style="color:${color};margin:1.25rem 0 .5rem;font-size:15px">${esc(title)} (${items.length})</h3>
            <table style="width:100%;border-collapse:collapse;font-size:13px">
                <thead><tr style="background:#f6f7f9">
                    <th style="padding:6px 10px;text-align:left">Item</th>
                    <th style="padding:6px 10px;text-align:left">Holder</th>
                    <th style="padding:6px 10px;text-align:right">Age</th>
                    <th style="padding:6px 10px;text-align:right">Value</th>
                </tr></thead><tbody>${items.map(row).join("")}</tbody>
            </table>`;
    }

    const htmlBody = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;font-size:14px;line-height:1.55;color:#0e1116;max-width:680px;margin:0 auto;padding:1.5rem">
        <h2 style="margin:0 0 .5rem;font-size:18px">LYMX outstanding property — weekly digest</h2>
        <p style="margin:0 0 .75rem;color:#5b6472">${queue.length} item${queue.length === 1 ? "" : "s"} outstanding · <strong>$${totalValAtRisk.toFixed(0)} at risk</strong>.</p>
        <p style="background:#eef5ff;border:1px solid #c5dffb;border-radius:8px;padding:10px 14px;color:#1d4ed8;font-size:12.5px;margin:.5rem 0 1rem">
            <strong>NRS 608.020 / 608.030:</strong> Final pay must be issued on the statutory timeline regardless of property return. Unreturned items are pursued separately — never as a hold-back against wages.
        </p>
        ${section("⚠ 90+ days — eligible for write-off", band90, "#9b1c1c")}
        ${section("60–89 days — escalation needed", band60, "#92400e")}
        ${section("30–59 days — first follow-up", band30, "#1f4fc1")}
        <p style="margin:1.5rem 0 .25rem"><a href="${linkBase}" style="display:inline-block;background:#0e1116;color:#fff;padding:9px 18px;border-radius:8px;font-weight:700;text-decoration:none">Open queue →</a></p>
        <p style="margin:1.5rem 0 0;color:#94a3b8;font-size:11.5px">Sent automatically by LYMX Power HR · ${new Date().toLocaleDateString()}</p>
    </div>`;

    const textBody = `LYMX outstanding property — weekly digest

${queue.length} item(s) outstanding · $${totalValAtRisk.toFixed(0)} at risk.

NRS 608.020 / 608.030: Final pay issued on schedule regardless of property return.

90+ days (eligible for write-off): ${band90.length}
60-89 days: ${band60.length}
30-59 days: ${band30.length}

Open queue: ${linkBase}`;

    // Send via send-email EF (channel='outreach' for internal HR comms)
    let okCount = 0;
    const failures: string[] = [];
    for (const r of recipients) {
        try {
            const resp = await fetch(SB_URL + "/functions/v1/send-email", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SB_KEY}`, "apikey": SB_KEY },
                body: JSON.stringify({
                    channel: "outreach",
                    recipient_email: r.email,
                    recipient_name: r.name,
                    subject,
                    body_text: textBody,
                    body_html: htmlBody,
                    template_key: "property_aging_weekly",
                }),
            });
            if (resp.ok) okCount++;
            else failures.push(r.email + ":" + resp.status);
        } catch (e) {
            failures.push(r.email + ":exception");
            console.warn("send-email failed", r.email, e);
        }
    }

    return json({
        ok: true,
        items: queue.length,
        sent_to: okCount,
        failures: failures.slice(0, 10),
        bands: { d30_59: band30.length, d60_89: band60.length, d90_plus: band90.length },
    });
});
