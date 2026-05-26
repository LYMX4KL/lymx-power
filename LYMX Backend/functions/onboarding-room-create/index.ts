// =============================================================================
// LYMX Power — Onboarding Room Create (Module 4)
// =============================================================================
// POST /functions/v1/onboarding-room-create
//
// Called immediately after a public booker confirms an onboarding call slot on
// book-onboarding-call.html. The EF:
//
//   1. Validates the booking row exists AND was created in the last 5 minutes
//      (anti-replay gate — anonymous callers can only invoke this for a
//      booking they just made themselves).
//   2. Creates a video room (Daily.co when DAILY_API_KEY is set, else
//      meet.jit.si fallback). Mirrors the team-calendar book-call EF pattern.
//   3. Updates onboarding_bookings with video_room_id / video_room_url /
//      video_room_data (matches migration 097 schema).
//   4. Sends a confirmation email to the booker AND a heads-up to the host
//      (the onboarding_hosts row owner) with the join URL + ICS attachment.
//
// REQUEST BODY:
//   { "booking_id": "uuid" }   // required
//
// AUTH: anon-callable. The freshness gate on booking row's created_at makes
// replay attacks impossible. We don't require a signed-in user because the
// booking page itself supports anon bookers.
//
// RESPONSE (200):
//   { "ok": true, "booking_id, video_room_url, video_room_id, host_email, sent_to_booker, sent_to_host" }
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

const FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

function rand(n = 10): string {
    const chars = "abcdefghijkmnpqrstuvwxyz23456789";
    let out = "";
    for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

function escHtml(s: string): string {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    } as Record<string, string>)[c]);
}

async function createDailyRoom(apiKey: string, opts: { name: string; endsAt: Date }) {
    const exp = Math.floor(opts.endsAt.getTime() / 1000) + 1800; // +30min buffer
    const properties: Record<string, unknown> = {
        exp,
        enable_chat: true,
        start_video_off: false,
        start_audio_off: false,
        eject_at_room_exp: true,
    };
    if (Deno.env.get("DAILY_ENABLE_RECORDING") === "true") {
        properties.enable_recording = "cloud";
    }
    if (Deno.env.get("DAILY_ENABLE_TRANSCRIPTION") === "true") {
        properties.enable_transcription = true;
    }
    const r = await fetch("https://api.daily.co/v1/rooms", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: opts.name, privacy: "public", properties }),
    });
    if (!r.ok) {
        const errBody = await r.text().catch(() => "");
        throw new Error(`Daily HTTP ${r.status}: ${errBody.slice(0, 200)}`);
    }
    return await r.json();
}

function buildJitsiRoom(): { url: string; id: string } {
    const slug = `LYMX-ON-${rand(10)}`;
    return { url: `https://meet.jit.si/${slug}#config.disableDeepLinking=true`, id: slug };
}

function buildIcs(opts: {
    uid: string;
    starts: Date;
    ends: Date;
    summary: string;
    description: string;
    location: string;
    organizer: string;
    attendee: string;
}): string {
    const fmt = (d: Date) => d.toISOString().replace(/[-:]|\.\d{3}/g, "");
    return [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//LYMX Power//Onboarding//EN",
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

async function sendViaResend(opts: {
    apiKey: string;
    to: string;
    subject: string;
    html: string;
    replyTo: string;
    ics?: { content: string; filename: string };
}): Promise<{ ok: boolean; error?: string; id?: string }> {
    const body: Record<string, unknown> = {
        from: "LYMX <kenny@lymxpower.com>",
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
        reply_to: opts.replyTo,
    };
    if (opts.ics) {
        body.attachments = [{
            filename: opts.ics.filename,
            content: btoa(opts.ics.content),
        }];
    }
    const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: (j as any).message || `http ${r.status}` };
    return { ok: true, id: (j as any).id };
}

function bookerEmail(args: {
    booker_name: string;
    host_display_name: string;
    business_label: string | null;
    starts: Date;
    duration_min: number;
    room_url: string;
}): { subject: string; html: string } {
    const startStr = args.starts.toLocaleString("en-US", {
        weekday: "long", month: "long", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", timeZoneName: "short",
    });
    const subject = `Your LYMX onboarding call is confirmed — ${startStr}`;
    const html = `<p>Hi ${escHtml(args.booker_name)},</p>

<p>You're booked. Here's everything you need for your ${args.duration_min}-minute LYMX onboarding call with ${escHtml(args.host_display_name)}:</p>

<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:14px 0;font-size:14.5px">
  <tr>
    <td style="padding:6px 12px 6px 0;color:#5b6472;font-weight:600">When</td>
    <td style="padding:6px 0">${escHtml(startStr)}</td>
  </tr>
  <tr>
    <td style="padding:6px 12px 6px 0;color:#5b6472;font-weight:600">Duration</td>
    <td style="padding:6px 0">${args.duration_min} minutes</td>
  </tr>
  <tr>
    <td style="padding:6px 12px 6px 0;color:#5b6472;font-weight:600">Host</td>
    <td style="padding:6px 0">${escHtml(args.host_display_name)}</td>
  </tr>
  ${args.business_label ? `<tr>
    <td style="padding:6px 12px 6px 0;color:#5b6472;font-weight:600">For</td>
    <td style="padding:6px 0">${escHtml(args.business_label)}</td>
  </tr>` : ""}
</table>

<p style="margin:18px 0"><a href="${args.room_url}" style="display:inline-block;background:#0a84ff;color:#fff;padding:13px 24px;border-radius:9px;font-weight:700;text-decoration:none">Join the call →</a></p>

<p style="color:#5b6472;font-size:13px;margin-top:-6px">Or paste this link into your browser at the call time:<br><a href="${args.room_url}">${args.room_url}</a></p>

<p style="background:#f0f7ff;border-left:4px solid #0a84ff;padding:10px 14px;border-radius:0 8px 8px 0;font-size:13.5px">A calendar invite is attached to this email — add it to your calendar so you don't miss it. The link works on desktop, mobile, and through the LYMX app.</p>

<p>Need to reschedule? Just reply to this email and we'll find another time. Bring questions about your POS setup, your first rewards issuance, or anything else about LYMX.</p>

<p>See you on the call.</p>

<p>— ${escHtml(args.host_display_name)}<br>
LYMX Power Inc.<br>
<a href="mailto:hello@getlymx.com">hello@getlymx.com</a></p>`;
    return { subject, html };
}

function hostEmail(args: {
    host_display_name: string;
    booker_name: string;
    booker_email: string;
    booker_phone: string | null;
    business_label: string | null;
    business_slug: string | null;
    notes: string | null;
    starts: Date;
    duration_min: number;
    room_url: string;
}): { subject: string; html: string } {
    const startStr = args.starts.toLocaleString("en-US", {
        weekday: "long", month: "long", day: "numeric",
        hour: "numeric", minute: "2-digit", timeZoneName: "short",
    });
    const subject = `New onboarding call — ${args.booker_name}${args.business_label ? " · " + args.business_label : ""} on ${startStr}`;
    const html = `<p>Hi ${escHtml(args.host_display_name)},</p>

<p>You have a new onboarding call booked:</p>

<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:14px 0;font-size:14.5px">
  <tr><td style="padding:4px 12px 4px 0;color:#5b6472;font-weight:600">Booker</td><td style="padding:4px 0">${escHtml(args.booker_name)} &lt;${escHtml(args.booker_email)}&gt;</td></tr>
  ${args.booker_phone ? `<tr><td style="padding:4px 12px 4px 0;color:#5b6472;font-weight:600">Phone</td><td style="padding:4px 0">${escHtml(args.booker_phone)}</td></tr>` : ""}
  ${args.business_label ? `<tr><td style="padding:4px 12px 4px 0;color:#5b6472;font-weight:600">Business</td><td style="padding:4px 0">${escHtml(args.business_label)}${args.business_slug ? ' <code style="font-size:12px;color:#5b6472">' + escHtml(args.business_slug) + '</code>' : ""}</td></tr>` : ""}
  <tr><td style="padding:4px 12px 4px 0;color:#5b6472;font-weight:600">When</td><td style="padding:4px 0">${escHtml(startStr)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#5b6472;font-weight:600">Duration</td><td style="padding:4px 0">${args.duration_min} minutes</td></tr>
  ${args.notes ? `<tr><td style="padding:4px 12px 4px 0;color:#5b6472;font-weight:600;vertical-align:top">Notes</td><td style="padding:4px 0;white-space:pre-wrap">${escHtml(args.notes)}</td></tr>` : ""}
</table>

<p style="margin:18px 0"><a href="${args.room_url}" style="display:inline-block;background:#0a84ff;color:#fff;padding:11px 20px;border-radius:8px;font-weight:700;text-decoration:none">Join the call →</a></p>

<p style="color:#5b6472;font-size:13px">Room URL: <a href="${args.room_url}">${args.room_url}</a></p>

${args.business_slug ? `<p style="color:#5b6472;font-size:13px;margin-top:14px">Open the application card to review the intake context before the call:<br>
<a href="https://getlymx.com/admin-business-applications.html">admin-business-applications.html</a></p>` : ""}

<p style="color:#5b6472;font-size:12.5px;margin-top:18px">— Automated message from LYMX Power onboarding</p>`;
    return { subject, html };
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST")    return err("Method not allowed", 405);

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
    const DAILY_KEY  = Deno.env.get("DAILY_API_KEY");
    if (!SB_URL || !SB_KEY) return err("Server config missing", 500);
    const supa = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

    let body: any;
    try { body = await req.json(); } catch { return err("Invalid JSON", 400); }
    const booking_id = (body.booking_id || "").trim();
    if (!booking_id) return err("booking_id is required", 400);

    // ─── Load booking ───
    const { data: bk, error: bkErr } = await supa
        .from("onboarding_bookings")
        .select("id, host_id, starts_at, ends_at, booker_name, booker_email, booker_phone, business_name, business_id, notes, video_room_url, video_room_id, status, created_at")
        .eq("id", booking_id)
        .maybeSingle();
    if (bkErr) return err(`booking lookup failed: ${bkErr.message}`, 500);
    if (!bk)   return err("Booking not found", 404);

    // ─── Freshness gate (anti-replay) ───
    const createdAt = bk.created_at ? new Date(bk.created_at).getTime() : 0;
    if (!createdAt || Date.now() - createdAt > FRESHNESS_WINDOW_MS) {
        return err("Booking too old — room creation must happen within 5 minutes of insert", 409);
    }

    // If a room already exists, return it (idempotent on retries).
    if (bk.video_room_url) {
        return json({
            ok: true,
            already_exists: true,
            booking_id: bk.id,
            video_room_url: bk.video_room_url,
            video_room_id: bk.video_room_id,
        });
    }

    if (bk.status !== "confirmed") {
        return err(`Booking status is '${bk.status}' — cannot create room`, 409);
    }

    // ─── Load host ───
    const { data: host, error: hostErr } = await supa
        .from("onboarding_hosts")
        .select("id, user_id, display_name, email, slot_minutes, timezone")
        .eq("id", bk.host_id)
        .maybeSingle();
    if (hostErr || !host) return err("Host not found for this booking", 404);

    // ─── Load linked business (if any) for the email context ───
    let bizLabel: string | null = bk.business_name || null;
    let bizSlug:  string | null = null;
    if (bk.business_id) {
        const { data: biz } = await supa
            .from("businesses")
            .select("slug, display_name, legal_name")
            .eq("id", bk.business_id)
            .maybeSingle();
        if (biz) {
            bizLabel = biz.display_name || biz.legal_name || bizLabel;
            bizSlug  = biz.slug || null;
        }
    }

    // ─── Create video room ───
    const starts = new Date(bk.starts_at);
    const ends   = new Date(bk.ends_at);
    const durMin = Math.max(1, Math.round((ends.getTime() - starts.getTime()) / 60000));
    const roomName = `LYMX-ON-${bk.id.slice(0, 8)}-${rand(6)}`;

    let videoRoomId = "";
    let videoRoomUrl = "";
    let videoRoomData: Record<string, unknown> = {};

    if (DAILY_KEY) {
        try {
            const room = await createDailyRoom(DAILY_KEY, { name: roomName, endsAt: ends });
            videoRoomId  = (room as any).name || roomName;
            videoRoomUrl = (room as any).url  || `https://lymx.daily.co/${videoRoomId}`;
            videoRoomData = { provider: "daily", created: room };
        } catch (e) {
            console.warn("[onboarding-room-create] Daily room create failed, falling back to Jitsi:", (e as Error).message);
            const j = buildJitsiRoom();
            videoRoomId = j.id;
            videoRoomUrl = j.url;
            videoRoomData = { provider: "jitsi", fallback_reason: (e as Error).message };
        }
    } else {
        const j = buildJitsiRoom();
        videoRoomId = j.id;
        videoRoomUrl = j.url;
        videoRoomData = { provider: "jitsi", reason: "no_daily_key" };
    }

    // ─── Persist room on the booking row ───
    {
        const { error: upErr } = await supa
            .from("onboarding_bookings")
            .update({
                video_room_id: videoRoomId,
                video_room_url: videoRoomUrl,
                video_room_data: videoRoomData,
                meeting_url: videoRoomUrl,  // keep legacy column in sync for any UI still reading it
            })
            .eq("id", bk.id);
        if (upErr) {
            return json({ ok: false, error: "room created but DB update failed: " + upErr.message, video_room_url: videoRoomUrl }, 500);
        }
    }

    // ─── Send confirmation emails ───
    // The booker's email is the canonical attendee. Host (Kenny / Founder /
    // Admin) gets a heads-up so they can review the application before the
    // call. ICS attachment goes to both so it lands on both calendars.
    const ics = buildIcs({
        uid: bk.id + "@getlymx.com",
        starts,
        ends,
        summary: `LYMX onboarding call with ${host.display_name}${bizLabel ? " for " + bizLabel : ""}`,
        description: `Join the call: ${videoRoomUrl}\n\nReply to this email to reschedule.`,
        location: videoRoomUrl,
        organizer: host.email,
        attendee: bk.booker_email,
    });

    let sentToBooker = false;
    let sentToHost   = false;
    if (RESEND_KEY) {
        const bk_email = bookerEmail({
            booker_name: bk.booker_name,
            host_display_name: host.display_name,
            business_label: bizLabel,
            starts, duration_min: durMin, room_url: videoRoomUrl,
        });
        const bk_send = await sendViaResend({
            apiKey: RESEND_KEY,
            to: bk.booker_email,
            subject: bk_email.subject,
            html: bk_email.html,
            replyTo: "kenny@lymxpower.com",
            ics: { content: ics, filename: "lymx-onboarding-call.ics" },
        });
        sentToBooker = bk_send.ok;
        if (!bk_send.ok) console.warn("[onboarding-room-create] booker email send failed:", bk_send.error);

        const host_tpl = hostEmail({
            host_display_name: host.display_name,
            booker_name: bk.booker_name,
            booker_email: bk.booker_email,
            booker_phone: bk.booker_phone || null,
            business_label: bizLabel,
            business_slug: bizSlug,
            notes: bk.notes || null,
            starts, duration_min: durMin, room_url: videoRoomUrl,
        });
        const host_send = await sendViaResend({
            apiKey: RESEND_KEY,
            to: host.email,
            subject: host_tpl.subject,
            html: host_tpl.html,
            replyTo: bk.booker_email,
            ics: { content: ics, filename: "lymx-onboarding-call.ics" },
        });
        sentToHost = host_send.ok;
        if (!host_send.ok) console.warn("[onboarding-room-create] host email send failed:", host_send.error);
    } else {
        console.warn("[onboarding-room-create] RESEND_API_KEY missing — skipping confirmation emails");
    }

    return json({
        ok: true,
        booking_id: bk.id,
        video_room_url: videoRoomUrl,
        video_room_id: videoRoomId,
        provider: (videoRoomData as any).provider,
        host_email: host.email,
        sent_to_booker: sentToBooker,
        sent_to_host: sentToHost,
    });
});
