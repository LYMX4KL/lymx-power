// =============================================================================
// LYMX Power — Daily partner digest
// =============================================================================
// POST or GET  /functions/v1/daily-digest
//
// Hit hourly by pg_cron. For every active team-calendar owner, checks whether
// it's their local "send hour" (default 17 = 5pm) AND a digest hasn't already
// been sent today (idempotent via team_calendars.last_digest_date). If both,
// builds a summary of the past 24h activity and emails it.
//
// Sections: Calls completed, No-shows, Still scheduled today, Won, Lost,
// New leads added, Stale leads (3+ days in current stage, top 3).
//
// Disable verify_jwt — public cron target.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function escapeHtml(s: string): string {
    return String(s == null ? "" : s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;" }[c] as string));
}

function localHour(tz: string): number {
    try {
        const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false });
        return parseInt(f.format(new Date()), 10);
    } catch (_) { return -1; }
}

function localDate(tz: string): string {
    try {
        return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    } catch (_) { return new Date().toISOString().slice(0, 10); }
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
    if (!SB_URL || !SB_KEY) return json({ ok: false, error: "Server config missing" }, 500);
    if (!RESEND_KEY) return json({ ok: false, error: "RESEND_API_KEY not set" }, 500);
    const supabase = createClient(SB_URL, SB_KEY);

    const url = new URL(req.url);
    const forceUserId = url.searchParams.get("force_user_id");
    const DEFAULT_SEND_HOUR = 17;

    const { data: cals, error: calErr } = await supabase
        .from("team_calendars")
        .select("id, user_id, handle, display_name, timezone, digest_send_hour, last_digest_date")
        .eq("is_active", true);
    if (calErr) return json({ ok: false, error: calErr.message }, 500);

    const results: any[] = [];
    const dayStart = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

    for (const cal of (cals || [])) {
        const tz = cal.timezone || "UTC";
        const sendHour = Number.isFinite(cal.digest_send_hour) ? cal.digest_send_hour : DEFAULT_SEND_HOUR;
        const todayLocal = localDate(tz);
        const hour = localHour(tz);

        if (forceUserId && forceUserId !== cal.user_id) continue;
        if (!forceUserId) {
            if (hour !== sendHour) { results.push({ handle: cal.handle, skipped: "not local send hour", hour, sendHour }); continue; }
            if (cal.last_digest_date === todayLocal) { results.push({ handle: cal.handle, skipped: "already sent today" }); continue; }
        }

        const { data: ownerUser } = await supabase.auth.admin.getUserById(cal.user_id);
        const ownerEmail = ownerUser?.user?.email || `${cal.handle}@getlymx.com`;
        const ownerName = cal.display_name || "LYMX Team";

        const { data: callsToday } = await supabase
            .from("bookings")
            .select("id, status, starts_at, booker_name, booker_email, summary, lead_id")
            .eq("team_calendar_id", cal.id)
            .gte("starts_at", dayStart);

        const completed = (callsToday || []).filter(b => b.status === "completed");
        const noShows = (callsToday || []).filter(b => b.status === "no_show");
        const nowIso = new Date().toISOString();
        const upcomingToday = (callsToday || []).filter(b => b.status === "confirmed" && b.starts_at > nowIso);

        const { data: newLeads } = await supabase
            .from("leads")
            .select("id, full_name, email, source, stage")
            .eq("owner_user_id", cal.user_id)
            .gte("created_at", dayStart);

        const { data: closedToday } = await supabase
            .from("leads")
            .select("id, full_name, email, stage, stage_changed_at")
            .eq("owner_user_id", cal.user_id)
            .in("stage", ["won", "lost"])
            .gte("stage_changed_at", dayStart);

        const staleCutoff = new Date(Date.now() - 3 * 86400 * 1000).toISOString();
        const { data: stale } = await supabase
            .from("leads")
            .select("id, full_name, email, stage, stage_changed_at")
            .eq("owner_user_id", cal.user_id)
            .not("stage", "in", "(won,lost)")
            .lte("stage_changed_at", staleCutoff)
            .order("stage_changed_at", { ascending: true })
            .limit(50);

        const totalSignal = (completed?.length || 0) + (noShows?.length || 0) + (newLeads?.length || 0) + (closedToday?.length || 0) + (upcomingToday?.length || 0);
        if (totalSignal === 0 && (stale?.length || 0) === 0) {
            await supabase.from("team_calendars").update({ last_digest_date: todayLocal }).eq("id", cal.id);
            results.push({ handle: cal.handle, skipped: "no activity" });
            continue;
        }

        const won = (closedToday || []).filter(l => l.stage === "won");
        const lost = (closedToday || []).filter(l => l.stage === "lost");

        const sec = (title: string, items: string[]) => items.length
            ? `<div style="margin:14px 0"><div style="font-size:13px;color:#5b6472;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">${escapeHtml(title)}</div><ul style="margin:0;padding-left:20px;font-size:14.5px">${items.map(x => `<li style="margin-bottom:3px">${x}</li>`).join("")}</ul></div>`
            : "";
        const todayPretty = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz });

        const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#0e1116;max-width:640px;margin:0 auto;padding:24px">`
          + `<h2 style="margin:0 0 12px;font-size:22px">📊 Your LYMX day · ${escapeHtml(todayPretty)}</h2>`
          + `<p>Hi ${escapeHtml(ownerName)},</p>`
          + `<p style="margin:0 0 12px">Here's your activity in the last 24 hours:</p>`
          + sec("✅ Calls completed", completed.map(b => `${escapeHtml(b.booker_name||"Guest")}${b.summary ? ` — <i style=\"color:#5b6472\">${escapeHtml((b.summary||"").slice(0,120))}</i>` : ""}`))
          + sec("🙁 No-shows", noShows.map(b => `${escapeHtml(b.booker_name||"Guest")} &lt;${escapeHtml(b.booker_email||"")}&gt; — <a href="https://getlymx.com/c/${escapeHtml(cal.handle)}" style="color:#0a84ff">share rebook link</a>`))
          + sec("📅 Still scheduled today", upcomingToday.map(b => {
              const t = new Date(b.starts_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
              return `<b>${escapeHtml(t)}</b> · ${escapeHtml(b.booker_name||"Guest")}`;
          }))
          + sec("🎉 Won today", won.map(l => escapeHtml(l.full_name || l.email || "")))
          + sec("❌ Lost today", lost.map(l => escapeHtml(l.full_name || l.email || "")))
          + sec("➕ New leads added", (newLeads || []).map(l => `${escapeHtml(l.full_name || l.email || "")}${l.source ? ` <span style=\"color:#5b6472;font-size:12px\">via ${escapeHtml(l.source)}</span>` : ""}`))
          + ((stale || []).length ? sec(`⏳ Going stale — top 3 of ${stale!.length}`, stale!.slice(0,3).map(l => {
              const days = Math.floor((Date.now() - new Date(l.stage_changed_at).getTime()) / 86400000);
              return `${escapeHtml(l.full_name || l.email || "")} — <span style="color:#92400e">${days}d in ${escapeHtml(l.stage)}</span>`;
          })) : "")
          + `<p style="margin-top:18px"><a href="https://getlymx.com/leads.html" style="display:inline-block;background:#0a84ff;color:#fff;padding:11px 22px;border-radius:9px;font-weight:700;text-decoration:none">📌 Open my pipeline</a></p>`
          + `<hr style="border:0;border-top:1px solid #e6e8ec;margin:24px 0 14px" />`
          + `<div style="font-size:12px;color:#5b6472">You're getting this because you have an active /c/${escapeHtml(cal.handle)} booking page. Tomorrow's digest fires at ${sendHour}:00 ${escapeHtml(tz)}.</div>`
          + `</div>`;
        const text = `Your LYMX day · ${todayPretty}\nCompleted: ${completed.length} | No-shows: ${noShows.length} | New leads: ${(newLeads||[]).length}\nWon: ${won.length} | Lost: ${lost.length} | Stale: ${(stale||[]).length}\nOpen pipeline: https://getlymx.com/leads.html`;

        try {
            const r = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    from: `LYMX <${ownerEmail}>`,
                    to: [ownerEmail],
                    subject: `Your LYMX day — ${todayPretty}`,
                    html, text,
                    reply_to: ownerEmail,
                }),
            });
            if (r.ok) {
                await supabase.from("team_calendars").update({ last_digest_date: todayLocal }).eq("id", cal.id);
                results.push({ handle: cal.handle, sent: true, completed: completed.length, no_shows: noShows.length, new_leads: (newLeads||[]).length, won: won.length, stale: (stale||[]).length });
            } else {
                results.push({ handle: cal.handle, sent: false, status: r.status });
            }
        } catch (e: any) {
            results.push({ handle: cal.handle, sent: false, error: e.message });
        }
    }

    return json({ ok: true, ran_at: new Date().toISOString(), results });
});
