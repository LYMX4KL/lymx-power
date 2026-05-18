// =============================================================================
// LYMX Power — Book Call (public booking endpoint with video room creation)
// =============================================================================
// POST /functions/v1/book-call
//
// Public endpoint — anyone can book a slot on a team member's calendar.
//
// REQUEST BODY:
//   {
//     handle: "kenny",                      // team_calendars.handle
//     starts_at: "2026-05-20T17:00:00Z",    // ISO datetime in UTC
//     duration_min?: 30,                    // optional; defaults to calendar's default
//     booker_name: "Maya López",
//     booker_email: "maya@example.com",
//     booker_phone?: "+17025550100",
//     booker_message?: "Want to learn about Founding Partner program",
//     company?: "Brew & Bean",
//     role_title?: "Owner",
//     booker_user_id?: "<uuid>"             // optional if logged-in
//   }
//
// WHAT IT DOES:
//   1. Validates the slot is open + within future window.
//   2. Creates/updates a leads row (one per email, with source=booking).
//   3. Creates a conversations thread (subject_type='none' if no existing
//      customer/business/partner; tags lead_id in metadata).
//   4. Creates a video room — Daily.co if DAILY_API_KEY is set, else a
//      meet.jit.si/lymx-<rand> URL (also works fine, just no recording).
//   5. Inserts the bookings row with all linkage.
//   6. Sends a confirmation email to BOTH the booker AND the calendar owner
//      with the video room URL + .ics calendar attachment.
//
// RESPONSE (200):
//   {
//     ok: true,
//     booking_id, lead_id, conversation_id,
//     video_room_url, starts_at_iso, calendar_owner_email
//   }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const err  = (m: string, s = 400) => json({ ok: false, error: m }, s);

function rand(n = 8): string {
    const chars = "abcdefghijkmnpqrstuvwxyz23456789";
    let out = "";
    for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

async function createDailyRoom(apiKey: string, opts: { name: string; expSeconds: number; startsAt: Date; endsAt: Date }) {
    const exp = Math.floor(opts.endsAt.getTime() / 1000) + 1800; // +30min buffer after end
    const r = await fetch("https://api.daily.co/v1/rooms", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            name: opts.name,
            privacy: "public",
            properties: {
                exp,
                enable_recording: "cloud",
                enable_transcription: true,
                enable_chat: true,
                start_video_off: false,
                start_audio_off: false,
                eject_at_room_exp: true,
            },
        }),
    });
    if (!r.ok) {
        const errBody = await r.text().catch(() => "");
        throw new Error(`Daily HTTP ${r.status}: ${errBody.slice(0, 200)}`);
    }
    const room = await r.json();
    return room;
}

function buildJitsiRoom(): { url: string; id: string } {
    const slug = `LYMX-${rand(10)}`;
    return { url: `https://meet.jit.si/${slug}#config.disableDeepLinking=true`, id: slug };
}

function escHtml(s: string): string {
    return String(s == null ? "" : s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;" }[c] as string));
}

function buildIcs(opts: { uid: string; starts: Date; ends: Date; summary: string; description: string; location: string; organizer: string; attendee: string }): string {
    const fmt = (d: Date) => d.toISOString().replace(/[-:]|\.\d{3}/g, "");
    return [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//LYMX Power//Bookings//EN",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        `UID:${opts.uid}`,
        `DTSTAMP:${fmt(new Date())}`,
        `DTSTART:${fmt(opts.starts)}`,
        `DTEND:${fmt(opts.ends)}`,
        `SUMMARY:${opts.summary.replace(/\n/g, " ")}`,
        `DESCRIPTION:${opts.description.replace(/\n/g, "\\n")}`,
        `LOCATION:${opts.location}`,
        `ORGANIZER:MAILTO:${opts.organizer}`,
        `ATTENDEE;RSVP=TRUE:MAILTO:${opts.attendee}`,
        "STATUS:CONFIRMED",
        "END:VEVENT",
        "END:VCALENDAR",
    ].join("\r\n");
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return err("Method not allowed", 405);

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
    const DAILY_KEY = Deno.env.get("DAILY_API_KEY");
    if (!SB_URL || !SB_KEY) return err("Server config missing", 500);
    const supabase = createClient(SB_URL, SB_KEY);

    let body: any;
    try { body = await req.json(); } catch { return err("Invalid JSON", 400); }
    const { handle, starts_at, booker_name, booker_email } = body;
    if (!handle || !starts_at || !booker_name || !booker_email) return err("handle, starts_at, booker_name, booker_email are required", 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(booker_email)) return err("Invalid booker_email", 400);

    // ---- 1. Resolve calendar ---------------------------------------------
    const { data: cal, error: calErr } = await supabase
        .from("team_calendars")
        .select("*")
        .eq("handle", handle)
        .eq("is_active", true)
        .maybeSingle();
    if (calErr || !cal) return err(`Calendar @${handle} not found or inactive`, 404);
    if (!cal.accepts_bookings) return err(`@${handle} is not accepting bookings right now`, 422);

    // ---- 2. Time validation -----------------------------------------------
    const starts = new Date(starts_at);
    if (isNaN(starts.getTime())) return err("Invalid starts_at", 400);
    const durationMin = Number.isFinite(body.duration_min) ? body.duration_min : cal.default_duration_min;
    const ends = new Date(starts.getTime() + durationMin * 60 * 1000);
    const now = new Date();
    const minNoticeMs = cal.min_notice_hours * 3600 * 1000;
    if (starts.getTime() - now.getTime() < minNoticeMs) return err(`Bookings must be at least ${cal.min_notice_hours} hours in advance`, 422);
    const maxAdvanceMs = cal.max_advance_days * 86400 * 1000;
    if (starts.getTime() - now.getTime() > maxAdvanceMs) return err(`Can't book more than ${cal.max_advance_days} days out`, 422);

    // ---- 3. Conflict check ------------------------------------------------
    const { data: conflict } = await supabase
        .from("bookings")
        .select("id")
        .eq("team_calendar_id", cal.id)
        .eq("starts_at", starts.toISOString())
        .in("status", ["pending", "confirmed"])
        .maybeSingle();
    if (conflict) return err("That time is already booked. Please pick another slot.", 409);

    // ---- 4. Resolve owner's email (for the confirmation email) ----------
    const { data: ownerUser } = await supabase.auth.admin.getUserById(cal.user_id);
    const ownerEmail = ownerUser?.user?.email || `${cal.handle}@getlymx.com`;

    // ---- 5. Upsert lead -----------------------------------------------------
    const normalizedEmail = booker_email.toLowerCase().trim();
    let { data: existingLead } = await supabase
        .from("leads").select("*").eq("email", normalizedEmail).maybeSingle();

    if (!existingLead) {
        const { data: newLead, error: leadErr } = await supabase
            .from("leads").insert({
                full_name: booker_name,
                email: normalizedEmail,
                phone: body.booker_phone || null,
                company: body.company || null,
                role_title: body.role_title || null,
                source: "booking",
                source_detail: `calendar:${handle}`,
                stage: "new",
                owner_user_id: cal.user_id,
            }).select().single();
        if (leadErr) return err(`Could not create lead: ${leadErr.message}`, 500);
        existingLead = newLead;
    } else {
        // Update name/phone/company if provided + assign to this calendar owner if unassigned
        await supabase.from("leads").update({
            full_name: existingLead.full_name || booker_name,
            phone: existingLead.phone || body.booker_phone || null,
            company: existingLead.company || body.company || null,
            role_title: existingLead.role_title || body.role_title || null,
            owner_user_id: existingLead.owner_user_id || cal.user_id,
            last_contacted_at: new Date().toISOString(),
        }).eq("id", existingLead.id);
    }
    const leadId = existingLead.id;

    // ---- 6. Ensure conversation thread exists for this lead -------------
    let conversationId: string | null = existingLead.conversation_id;
    if (!conversationId) {
        // Look up customer/business/partner by booker email to anchor the thread
        let subjectType: "customer" | "business" | "partner" | "none" = "none";
        let subjectId: string | null = null;
        const { data: cust } = await supabase.from("customers").select("id").ilike("email", normalizedEmail).maybeSingle();
        if (cust) { subjectType = "customer"; subjectId = cust.id; }
        else {
            const { data: biz } = await supabase.from("businesses").select("id").ilike("contact_email", normalizedEmail).maybeSingle();
            if (biz) { subjectType = "business"; subjectId = biz.id; }
            else {
                const { data: prt } = await supabase.from("partners").select("id").ilike("contact_email", normalizedEmail).maybeSingle();
                if (prt) { subjectType = "partner"; subjectId = prt.id; }
            }
        }
        const { data: convId, error: rpcErr } = await supabase.rpc("fn_find_or_create_conversation", {
            p_subject_type: subjectType,
            p_subject_id:   subjectId,
            p_kind:         "sales",
            p_title:        `Call with ${booker_name}`,
            p_source:       "booking",
            p_created_by:   cal.user_id,
        });
        if (!rpcErr && convId) {
            conversationId = convId as unknown as string;
            await supabase.from("leads").update({ conversation_id: conversationId }).eq("id", leadId);
        }
    }

    // ---- 7. Create video room (Daily.co if key set, else Jitsi) ---------
    let videoProvider = "jitsi";
    let videoUrl = "";
    let videoRoomId = "";
    let videoData: Record<string, unknown> = {};
    if (DAILY_KEY) {
        try {
            const roomName = `lymx-${cal.handle}-${rand(6)}`;
            const room = await createDailyRoom(DAILY_KEY, {
                name: roomName,
                expSeconds: 7200,
                startsAt: starts,
                endsAt: ends,
            });
            videoProvider = "daily";
            videoUrl = room.url;
            videoRoomId = room.id || room.name;
            videoData = room;
        } catch (e: any) {
            console.warn(`[book-call] Daily room creation failed, falling back to Jitsi: ${e.message}`);
            const j = buildJitsiRoom();
            videoUrl = j.url; videoRoomId = j.id;
        }
    } else {
        const j = buildJitsiRoom();
        videoUrl = j.url; videoRoomId = j.id;
    }

    // ---- 8. Insert booking -----------------------------------------------
    const { data: booking, error: bookErr } = await supabase
        .from("bookings").insert({
            team_calendar_id: cal.id,
            lead_id: leadId,
            booker_user_id: body.booker_user_id || null,
            booker_name,
            booker_email: normalizedEmail,
            booker_phone: body.booker_phone || null,
            booker_message: body.booker_message || null,
            starts_at: starts.toISOString(),
            ends_at: ends.toISOString(),
            duration_min: durationMin,
            video_provider: videoProvider,
            video_room_url: videoUrl,
            video_room_id: videoRoomId,
            video_room_data: videoData,
            status: "confirmed",
        }).select().single();
    if (bookErr) return err(`Could not save booking: ${bookErr.message}`, 500);

    // ---- 9. Append a system message to the conversation -----------------
    if (conversationId) {
        const startsLocal = starts.toLocaleString("en-US", { timeZone: cal.timezone, dateStyle: "full", timeStyle: "short" });
        await supabase.from("conversation_messages").insert({
            conversation_id: conversationId,
            sender_user_id: null,
            sender_type: "system",
            sender_name_snapshot: "Booking",
            channel: "system",
            body: `📅 Call booked: ${booker_name} ↔ ${cal.display_name}\n${startsLocal} (${durationMin} min)\nVideo: ${videoUrl}\n${body.booker_message ? "\nNote: " + body.booker_message : ""}`,
            direction: "internal",
        });
    }

    // ---- 10. Send confirmation emails -----------------------------------
    if (RESEND_KEY) {
        const startsLocal = starts.toLocaleString("en-US", { timeZone: cal.timezone, dateStyle: "full", timeStyle: "short" });
        const tzLabel = cal.timezone;
        const subjectLine = `Call confirmed: ${cal.display_name} ↔ ${booker_name} — ${starts.toUTCString().slice(0, 22)}`;
        const ics = buildIcs({
            uid: booking.id + "@getlymx.com",
            starts, ends,
            summary: `LYMX call: ${cal.display_name} ↔ ${booker_name}`,
            description: `Video: ${videoUrl}\n\n${body.booker_message || ""}`,
            location: videoUrl,
            organizer: ownerEmail,
            attendee: normalizedEmail,
        });
        const sharedHtml = (recipientName: string, otherName: string) =>
            `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#0e1116;max-width:600px;margin:0 auto;padding:24px">`
          + `<h2 style="margin:0 0 12px;font-size:22px">📅 Your call is confirmed</h2>`
          + `<p>Hi ${escHtml(recipientName)},</p>`
          + `<p>You're on with <b>${escHtml(otherName)}</b>.</p>`
          + `<div style="background:#eef4ff;border-left:3px solid #0a84ff;padding:14px 16px;border-radius:6px;margin:14px 0">`
          +   `<div style="font-weight:700;font-size:16px;color:#0e1116">${escHtml(startsLocal)}</div>`
          +   `<div style="font-size:13px;color:#5b6472;margin-top:2px">${escHtml(tzLabel)} · ${durationMin} min</div>`
          + `</div>`
          + `<p><a href="${videoUrl}" style="display:inline-block;background:#0a84ff;color:#fff;padding:11px 22px;border-radius:9px;font-weight:700;text-decoration:none">🎥 Join the call</a></p>`
          + (body.booker_message ? `<div style="margin:14px 0;font-size:14px;color:#5b6472"><b>Note from ${escHtml(booker_name)}:</b><br>${escHtml(body.booker_message)}</div>` : "")
          + `<hr style="border:0;border-top:1px solid #e6e8ec;margin:24px 0 14px" />`
          + `<div style="font-size:12px;color:#5b6472">Need to reschedule? Reply to this email — we'll sort it out.</div>`
          + `</div>`;

        const sendOne = async (to: string, html: string) => {
            try {
                await fetch("https://api.resend.com/emails", {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
                    body: JSON.stringify({
                        from: `LYMX <${ownerEmail}>`,
                        to: [to],
                        subject: subjectLine,
                        html,
                        text: `Your call is confirmed.\n${startsLocal} (${tzLabel})\nDuration: ${durationMin} min\nJoin: ${videoUrl}`,
                        reply_to: ownerEmail,
                        attachments: [{ filename: "call.ics", content: btoa(ics) }],
                    }),
                });
            } catch (e) { console.warn(`[book-call] email send to ${to} failed: ${(e as Error).message}`); }
        };
        await sendOne(normalizedEmail, sharedHtml(booker_name, cal.display_name));
        await sendOne(ownerEmail,      sharedHtml(cal.display_name, booker_name));
    }

    return json({
        ok: true,
        booking_id: booking.id,
        lead_id: leadId,
        conversation_id: conversationId,
        video_room_url: videoUrl,
        video_provider: videoProvider,
        starts_at_iso: starts.toISOString(),
        calendar_owner_email: ownerEmail,
    });
});
