// =============================================================================
// LYMX Power — Booking reminder cron (T-24h and T-1h)
// =============================================================================
// GET / POST  /functions/v1/booking-reminders
//
// Designed to be called by a cron job every 5-15 minutes. Idempotent — each
// booking can only fire each reminder once (24h and 1h sent_at columns gate it).
//
// Two reminders are sent per booking:
//   * T-24h reminder ("Tomorrow at <time> — here's the join link")
//   * T-1h reminder  ("Starting in an hour")
//
// Both go to the booker's email + the team-calendar owner's email so neither
// side forgets.
//
// SCHEDULING:
//   The simplest way: enable pg_cron in Supabase, then run
//     select cron.schedule('booking-reminders', '*/10 * * * *',
//       $$ select net.http_post(
//            url:='https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/booking-reminders',
//            headers:='{"Content-Type":"application/json"}'::jsonb
//          ); $$);
//   Alternatively use Netlify Scheduled Functions or any external cron that
//   hits this URL on a schedule.
//
// REQUIRES (Supabase secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (default)
//   RESEND_API_KEY (optional but useless without)
//
// Disable verify_jwt on this function — it's a public cron target.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function escHtml(s: string): string {
    return String(s == null ? "" : s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;" }[c] as string));
}

async function sendEmail(resendKey: string, opts: { from: string, to: string, subject: string, html: string, text: string, replyTo?: string }): Promise<boolean> {
    try {
        const r = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                from: opts.from,
                to: [opts.to],
                subject: opts.subject,
                html: opts.html,
                text: opts.text,
                reply_to: opts.replyTo,
            }),
        });
        if (!r.ok) {
            console.warn(`[booking-reminders] resend ${opts.to} -> ${r.status}: ${await r.text().catch(() => "")}`);
            return false;
        }
        return true;
    } catch (e: any) {
        console.warn(`[booking-reminders] resend ${opts.to} threw: ${e.message}`);
        return false;
    }
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
    if (!SB_URL || !SB_KEY) return json({ ok: false, error: "Server config missing" }, 500);
    if (!RESEND_KEY) return json({ ok: false, error: "RESEND_API_KEY not set — cannot send reminders" }, 500);
    const supabase = createClient(SB_URL, SB_KEY);

    const now = new Date();

    // 24-hour reminders: bookings starting between now+23h and now+25h that haven't been reminded
    const t24Lo = new Date(now.getTime() + 23 * 3600 * 1000).toISOString();
    const t24Hi = new Date(now.getTime() + 25 * 3600 * 1000).toISOString();
    // 1-hour reminders: bookings starting between now+50min and now+70min
    const t1Lo = new Date(now.getTime() + 50 * 60 * 1000).toISOString();
    const t1Hi = new Date(now.getTime() + 70 * 60 * 1000).toISOString();

    type BookingRow = {
        id: string; booker_name: string; booker_email: string; starts_at: string; ends_at: string;
        duration_min: number; video_room_url: string; cancel_token: string | null;
        booker_message: string | null;
        team_calendar_id: string;
        reminder_24h_sent_at: string | null;
        reminder_1h_sent_at: string | null;
    };

    const summary = { t24: { found: 0, emailed: 0 }, t1: { found: 0, emailed: 0 } };

    for (const kind of ["t24", "t1"] as const) {
        const lo = kind === "t24" ? t24Lo : t1Lo;
        const hi = kind === "t24" ? t24Hi : t1Hi;
        const flagCol = kind === "t24" ? "reminder_24h_sent_at" : "reminder_1h_sent_at";

        const { data: bookings, error: qErr } = await supabase
            .from("bookings")
            .select("id, booker_name, booker_email, starts_at, ends_at, duration_min, video_room_url, cancel_token, booker_message, team_calendar_id, reminder_24h_sent_at, reminder_1h_sent_at")
            .eq("status", "confirmed")
            .gte("starts_at", lo)
            .lte("starts_at", hi)
            .is(flagCol, null)
            .limit(100);
        if (qErr) { console.warn(`[booking-reminders] ${kind} query: ${qErr.message}`); continue; }
        summary[kind].found = bookings?.length || 0;
        if (!bookings || !bookings.length) continue;

        for (const b of bookings as BookingRow[]) {
            // Look up calendar owner email + display_name
            const { data: cal } = await supabase
                .from("team_calendars")
                .select("user_id, handle, display_name, timezone")
                .eq("id", b.team_calendar_id)
                .maybeSingle();
            if (!cal) continue;
            const { data: ownerUser } = await supabase.auth.admin.getUserById(cal.user_id);
            const ownerEmail: string = ownerUser?.user?.email || `${cal.handle}@getlymx.com`;
            const ownerName: string = cal.display_name || "LYMX Team";

            const startsLocal = new Date(b.starts_at).toLocaleString("en-US", { timeZone: cal.timezone || "UTC", dateStyle: "full", timeStyle: "short" });
            const tz = cal.timezone || "UTC";
            const cancelUrl = b.cancel_token
                ? `https://getlymx.com/booking-cancel.html?id=${b.id}&token=${encodeURIComponent(b.cancel_token)}`
                : null;

            const headline = kind === "t24"
                ? `⏰ Your call is tomorrow — ${ownerName} ↔ ${b.booker_name}`
                : `📞 Starting in an hour — ${ownerName} ↔ ${b.booker_name}`;
            const intro = kind === "t24"
                ? "Quick reminder — your call is tomorrow."
                : "Heads up — your call starts in about an hour.";
            const sharedHtml = (recipientName: string, otherName: string) =>
                `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#0e1116;max-width:600px;margin:0 auto;padding:24px">`
              + `<h2 style="margin:0 0 12px;font-size:22px">${headline}</h2>`
              + `<p>Hi ${escHtml(recipientName)},</p>`
              + `<p>${intro} You're on with <b>${escHtml(otherName)}</b>.</p>`
              + `<div style="background:#eef4ff;border-left:3px solid #0a84ff;padding:14px 16px;border-radius:6px;margin:14px 0">`
              +   `<div style="font-weight:700;font-size:16px;color:#0e1116">${escHtml(startsLocal)}</div>`
              +   `<div style="font-size:13px;color:#5b6472;margin-top:2px">${escHtml(tz)} · ${b.duration_min} min</div>`
              + `</div>`
              + `<p><a href="${b.video_room_url}" style="display:inline-block;background:#0a84ff;color:#fff;padding:11px 22px;border-radius:9px;font-weight:700;text-decoration:none">🎥 Join the call</a></p>`
              + (cancelUrl ? `<div style="font-size:12px;color:#5b6472;margin-top:18px">Can't make it? <a href="${cancelUrl}" style="color:#dc2626;font-weight:600">Cancel</a> so the slot opens back up.</div>` : "")
              + `</div>`;
            const text = `${intro}\n${startsLocal} (${tz})\nJoin: ${b.video_room_url}${cancelUrl ? `\nCancel: ${cancelUrl}` : ""}`;

            let oneSent = false;
            if (b.booker_email) {
                const ok = await sendEmail(RESEND_KEY, {
                    from: `LYMX <${ownerEmail}>`,
                    to: b.booker_email,
                    subject: headline,
                    html: sharedHtml(b.booker_name, ownerName),
                    text,
                    replyTo: ownerEmail,
                });
                if (ok) oneSent = true;
            }
            // Reminder to the owner too (but the T-1h one — at T-24h owners get noisy, skip)
            if (kind === "t1" && ownerEmail) {
                const ok = await sendEmail(RESEND_KEY, {
                    from: `LYMX <${ownerEmail}>`,
                    to: ownerEmail,
                    subject: headline,
                    html: sharedHtml(ownerName, b.booker_name),
                    text,
                    replyTo: b.booker_email,
                });
                if (ok) oneSent = true;
            }

            if (oneSent) {
                summary[kind].emailed += 1;
                await supabase.from("bookings").update({ [flagCol]: new Date().toISOString() }).eq("id", b.id);
            }
        }
    }

    // ---- 3. Post-call follow-up (T+24h after call completed) -----------
    const fuLo = new Date(now.getTime() - 25 * 3600 * 1000).toISOString();
    const fuHi = new Date(now.getTime() - 23 * 3600 * 1000).toISOString();
    const fuSummary = { found: 0, emailed: 0 };

    const { data: completedBookings, error: fuQErr } = await supabase
        .from("bookings")
        .select("id, booker_name, booker_email, starts_at, summary, action_items, team_calendar_id, lead_id")
        .eq("status", "completed")
        .gte("completed_at", fuLo)
        .lte("completed_at", fuHi)
        .is("follow_up_sent_at", null)
        .not("summary", "is", null)
        .limit(100);
    if (fuQErr) console.warn(`[booking-reminders] follow-up query: ${fuQErr.message}`);
    fuSummary.found = completedBookings?.length || 0;

    for (const b of (completedBookings || [])) {
        const { data: cal } = await supabase
            .from("team_calendars")
            .select("user_id, display_name, handle")
            .eq("id", b.team_calendar_id)
            .maybeSingle();
        if (!cal) continue;
        const { data: ownerUser } = await supabase.auth.admin.getUserById(cal.user_id);
        const ownerEmail = ownerUser?.user?.email || `${cal.handle}@getlymx.com`;
        const ownerName = cal.display_name || "LYMX Team";

        const aiSummary = String(b.summary || "").trim();
        const actions = Array.isArray(b.action_items) ? b.action_items : [];
        const leadLink = b.lead_id ? `https://getlymx.com/leads.html?lead=${b.lead_id}` : "https://getlymx.com/leads.html";
        const callDate = new Date(b.starts_at).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

        const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#0e1116;max-width:600px;margin:0 auto;padding:24px">`
          + `<h2 style="margin:0 0 12px;font-size:22px">📞 Yesterday's call with ${escHtml(b.booker_name)}</h2>`
          + `<p>Hi ${escHtml(ownerName)},</p>`
          + `<p>You spoke with <b>${escHtml(b.booker_name)}</b> on ${escHtml(callDate)}. Here's the recap from the AI summary so you can follow up:</p>`
          + `<div style="background:#eef4ff;border-left:3px solid #0a84ff;padding:14px 16px;border-radius:6px;margin:14px 0">`
          +   `<div style="font-weight:700;font-size:13px;color:#5b6472;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Recap</div>`
          +   `<div style="font-size:14.5px;color:#0e1116">${escHtml(aiSummary)}</div>`
          + `</div>`
          + (actions.length
              ? `<div style="margin:14px 0"><div style="font-weight:700;font-size:13px;color:#5b6472;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Action items</div><ul style="margin:0 0 0 18px;padding:0">${actions.map((a: any) => `<li style="margin-bottom:4px">${escHtml(String(a))}</li>`).join("")}</ul></div>`
              : "")
          + `<p style="margin-top:18px"><a href="${leadLink}" style="display:inline-block;background:#0a84ff;color:#fff;padding:11px 22px;border-radius:9px;font-weight:700;text-decoration:none">📌 Open lead in pipeline</a></p>`
          + `<hr style="border:0;border-top:1px solid #e6e8ec;margin:24px 0 14px" />`
          + `<div style="font-size:12px;color:#5b6472">Automatic follow-up nudge from LYMX — fresh leads convert ~3× better when you follow up within 48 hours.</div>`
          + `</div>`;
        const text = `Yesterday you spoke with ${b.booker_name}.\n\nRecap: ${aiSummary}\n\n${actions.length ? "Action items:\n" + actions.map((a: any) => "- " + a).join("\n") + "\n\n" : ""}Open lead in pipeline: ${leadLink}`;

        const ok = await sendEmail(RESEND_KEY, {
            from: `LYMX <${ownerEmail}>`,
            to: ownerEmail,
            subject: `Follow up: ${b.booker_name} — yesterday's call recap`,
            html,
            text,
            replyTo: b.booker_email || ownerEmail,
        });
        if (ok) {
            fuSummary.emailed += 1;
            await supabase.from("bookings").update({ follow_up_sent_at: new Date().toISOString() }).eq("id", b.id);
        }
    }

    return json({ ok: true, summary, follow_up: fuSummary, ran_at: now.toISOString() });
});
