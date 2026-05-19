// =============================================================================
// LYMX Power — Cancel a booking (public, token-validated)
// =============================================================================
// POST /functions/v1/booking-cancel
//
// Called from the cancel link in confirmation/reminder emails, OR from
// team-calendar.html's "Cancel" action by the team member, OR from
// admin-conversations.html by an admin.
//
// REQUEST BODY:
//   {
//     booking_id: "<uuid>",
//     token: "<cancel_token from bookings>",   // public-link path
//     reason?: "Scheduling conflict",
//     cancelled_by?: "booker" | "team" | "admin"   // defaults to 'booker' when token-only
//   }
//
// WHAT IT DOES:
//   1. Validates booking_id + token. Refuses if booking already cancelled / completed.
//   2. Marks the bookings row status='cancelled', cancelled_at=now, cancelled_by, cancelled_reason.
//   3. If video_provider='daily', DELETEs the Daily.co room (so it doesn't count against quota).
//   4. If the team-calendar owner connected Google AND the booking has a google_event_id, DELETEs that event from their Google Calendar.
//   5. Posts a system message into the lead's conversation thread.
//   6. Sends a "Call cancelled" email to BOTH the booker and the team-calendar owner with a "Book another time" CTA.
//
// RESPONSE:
//   { ok: true, booking_id, status: "cancelled", daily_deleted, google_deleted, emailed_count }
//
// REQUIRES (Supabase secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (default)
//   RESEND_API_KEY (optional — cancellation emails skip if missing)
//   DAILY_API_KEY  (optional — Daily room cleanup skips if missing)
//   GOOGLE_OAUTH_CLIENT_ID / _SECRET (optional — Google event delete skips if missing)
//
// Disable verify_jwt — this is a public endpoint (link from email).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const err = (m: string, s = 400) => json({ ok: false, error: m }, s);

function escHtml(s: string): string {
    return String(s == null ? "" : s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;" }[c] as string));
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return err("Method not allowed", 405);

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
    const DAILY_KEY = Deno.env.get("DAILY_API_KEY");
    const GOOGLE_CID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
    const GOOGLE_CSECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
    if (!SB_URL || !SB_KEY) return err("Server config missing", 500);
    const supabase = createClient(SB_URL, SB_KEY);

    let body: any;
    try { body = await req.json(); } catch { return err("Invalid JSON", 400); }
    const bookingId = String(body.booking_id || "").trim();
    const token = String(body.token || "").trim();
    const reason = String(body.reason || "").slice(0, 500);
    let cancelledBy = String(body.cancelled_by || "booker");
    if (!["booker", "team", "admin", "system"].includes(cancelledBy)) cancelledBy = "booker";
    if (!bookingId || !token) return err("booking_id and token are required", 400);

    // ---- 1. Load booking + verify token + state ---------------------------
    const { data: booking, error: bErr } = await supabase
        .from("bookings")
        .select("*")
        .eq("id", bookingId)
        .eq("cancel_token", token)
        .maybeSingle();
    if (bErr) return err(`Lookup failed: ${bErr.message}`, 500);
    if (!booking) return err("Booking not found or link expired", 404);
    if (booking.status === "cancelled") {
        return json({ ok: true, already: true, booking_id: bookingId, status: "cancelled" });
    }
    if (booking.status === "completed") return err("Cannot cancel — call already completed", 409);

    // ---- 2. Load calendar owner info (for cancellation email) -------------
    const { data: cal } = await supabase
        .from("team_calendars")
        .select("user_id, handle, display_name, timezone")
        .eq("id", booking.team_calendar_id)
        .maybeSingle();
    const { data: ownerUser } = cal ? await supabase.auth.admin.getUserById(cal.user_id) : { data: null };
    const ownerEmail: string = ownerUser?.user?.email || (cal ? `${cal.handle}@getlymx.com` : "team@getlymx.com");
    const ownerName: string = cal?.display_name || "LYMX Team";

    // ---- 3. Mark booking cancelled ---------------------------------------
    const { error: updErr } = await supabase
        .from("bookings")
        .update({
            status: "cancelled",
            cancelled_at: new Date().toISOString(),
            cancelled_by: cancelledBy,
            cancelled_reason: reason || null,
        })
        .eq("id", bookingId);
    if (updErr) return err(`Could not cancel: ${updErr.message}`, 500);

    // ---- 4. Delete Daily room (best-effort, non-fatal) -------------------
    let dailyDeleted = false;
    if (booking.video_provider === "daily" && booking.video_room_id && DAILY_KEY) {
        try {
            const r = await fetch(`https://api.daily.co/v1/rooms/${encodeURIComponent(booking.video_room_id)}`, {
                method: "DELETE",
                headers: { "Authorization": `Bearer ${DAILY_KEY}` },
            });
            dailyDeleted = r.ok;
            if (!r.ok) console.warn(`[booking-cancel] Daily delete ${r.status}: ${await r.text().catch(() => "")}`);
        } catch (e: any) {
            console.warn(`[booking-cancel] Daily delete threw: ${e.message}`);
        }
    }

    // ---- 5. Delete Google Calendar event (best-effort, non-fatal) --------
    let googleDeleted = false;
    const googleEventId = (booking.video_room_data && booking.video_room_data.google_event_id) || null;
    if (cal && googleEventId && GOOGLE_CID && GOOGLE_CSECRET) {
        try {
            // Look up token row + refresh if needed
            const { data: tokenRow } = await supabase
                .from("oauth_tokens").select("*")
                .eq("user_id", cal.user_id).eq("provider", "google").maybeSingle();
            if (tokenRow) {
                let accessToken = tokenRow.access_token;
                const expiring = tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date(Date.now() + 30000);
                if (expiring && tokenRow.refresh_token) {
                    const rr = await fetch("https://oauth2.googleapis.com/token", {
                        method: "POST",
                        headers: { "Content-Type": "application/x-www-form-urlencoded" },
                        body: new URLSearchParams({ client_id: GOOGLE_CID, client_secret: GOOGLE_CSECRET, refresh_token: tokenRow.refresh_token, grant_type: "refresh_token" }).toString(),
                    });
                    if (rr.ok) {
                        const jj = await rr.json();
                        accessToken = jj.access_token;
                        await supabase.from("oauth_tokens").update({
                            access_token: accessToken,
                            expires_at: jj.expires_in ? new Date(Date.now() + jj.expires_in * 1000).toISOString() : null,
                            last_refreshed_at: new Date().toISOString(),
                        }).eq("id", tokenRow.id);
                    }
                }
                const delResp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(googleEventId)}?sendUpdates=none`, {
                    method: "DELETE",
                    headers: { "Authorization": `Bearer ${accessToken}` },
                });
                googleDeleted = delResp.ok || delResp.status === 410; // 410 = already gone, treat as success
                if (!googleDeleted) console.warn(`[booking-cancel] Google delete ${delResp.status}: ${await delResp.text().catch(() => "")}`);
            }
        } catch (e: any) {
            console.warn(`[booking-cancel] Google delete threw: ${e.message}`);
        }
    }

    // ---- 6. Post system message into the lead's conversation -------------
    let conversationId: string | null = null;
    if (booking.lead_id) {
        const { data: lead } = await supabase.from("leads").select("conversation_id").eq("id", booking.lead_id).maybeSingle();
        conversationId = lead?.conversation_id || null;
    }
    if (conversationId) {
        const startsLocal = new Date(booking.starts_at).toLocaleString("en-US", { timeZone: cal?.timezone || "UTC", dateStyle: "full", timeStyle: "short" });
        const who = cancelledBy === "booker" ? booking.booker_name : ownerName;
        const reasonLine = reason ? `\nReason: ${reason}` : "";
        await supabase.from("conversation_messages").insert({
            conversation_id: conversationId,
            sender_user_id: null,
            sender_type: "system",
            sender_name_snapshot: "Booking",
            channel: "system",
            body: `❌ Call cancelled by ${who}\n${startsLocal}${reasonLine}`,
            direction: "internal",
        });
    }

    // ---- 7. Send cancellation emails (best-effort) ----------------------
    let emailedCount = 0;
    if (RESEND_KEY && booking.booker_email && cal) {
        const startsLocal = new Date(booking.starts_at).toLocaleString("en-US", { timeZone: cal.timezone || "UTC", dateStyle: "full", timeStyle: "short" });
        const tz = cal.timezone || "UTC";
        const rebookUrl = `https://getlymx.com/c/${cal.handle}`;
        const subject = `Cancelled: ${escHtml(cal.display_name)} ↔ ${escHtml(booking.booker_name)} — ${startsLocal}`;
        const html = (recipientName: string, otherName: string) =>
            `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#0e1116;max-width:600px;margin:0 auto;padding:24px">`
          + `<h2 style="margin:0 0 12px;font-size:22px">❌ Your call was cancelled</h2>`
          + `<p>Hi ${escHtml(recipientName)},</p>`
          + `<p>The call with <b>${escHtml(otherName)}</b> scheduled for <b>${escHtml(startsLocal)}</b> (${escHtml(tz)}) has been cancelled${cancelledBy === "booker" ? " by the guest" : cancelledBy === "team" ? " by the host" : ""}.</p>`
          + (reason ? `<div style="margin:14px 0;padding:12px 14px;background:#fef3c7;border-radius:8px;font-size:14px"><b>Reason:</b> ${escHtml(reason)}</div>` : "")
          + `<p style="margin-top:18px"><a href="${rebookUrl}" style="display:inline-block;background:#0a84ff;color:#fff;padding:11px 22px;border-radius:9px;font-weight:700;text-decoration:none">📅 Book another time</a></p>`
          + `<hr style="border:0;border-top:1px solid #e6e8ec;margin:24px 0 14px" />`
          + `<div style="font-size:12px;color:#5b6472">Reply to this email if you need help picking a new time.</div>`
          + `</div>`;
        const sendOne = async (to: string, body: string) => {
            try {
                const r = await fetch("https://api.resend.com/emails", {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
                    body: JSON.stringify({
                        from: `LYMX <${ownerEmail}>`,
                        to: [to],
                        subject,
                        html: body,
                        text: `Your call was cancelled. ${startsLocal} (${tz}). Book another time: ${rebookUrl}`,
                        reply_to: ownerEmail,
                    }),
                });
                if (r.ok) emailedCount++;
                else console.warn(`[booking-cancel] resend ${to} -> ${r.status}: ${await r.text().catch(() => "")}`);
            } catch (e: any) { console.warn(`[booking-cancel] resend ${to} threw: ${e.message}`); }
        };
        await sendOne(booking.booker_email, html(booking.booker_name, ownerName));
        await sendOne(ownerEmail,           html(ownerName, booking.booker_name));
    }

    return json({
        ok: true,
        booking_id: bookingId,
        status: "cancelled",
        cancelled_by: cancelledBy,
        daily_deleted: dailyDeleted,
        google_deleted: googleDeleted,
        emailed_count: emailedCount,
    });
});
