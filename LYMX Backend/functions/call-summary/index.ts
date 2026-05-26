// =============================================================================
// LYMX Power — Call Summary (Daily.co webhook → Claude transcript summary)
// =============================================================================
// POST /functions/v1/call-summary
//
// Webhook receiver from Daily.co. Configure in Daily Dashboard → Developers →
// Webhooks → New webhook:
//   * URL: https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/call-summary
//   * Events: meeting.ended, transcript.ready-to-download, recording.ready-to-download
//   * (Optionally) HMAC secret — set DAILY_WEBHOOK_SECRET in Supabase secrets
//     to verify each delivery.
//
// FLOW:
//   1. meeting.ended fires → mark the booking as completed.
//   2. transcript.ready-to-download fires → fetch the transcript JSON from Daily,
//      save the raw text to bookings.transcript.
//   3. Once transcript is in hand, send it to Claude Haiku to produce a short
//      summary + action items. Save to bookings.summary + .action_items.
//   4. Post a system message into the conversation thread anchored on the lead
//      so the next time the team opens the thread they see the recap.
//
// REQUIRES (set as Supabase Edge Function Secrets):
//   * DAILY_API_KEY              (already set)
//   * ANTHROPIC_API_KEY          (already set)
//   * DAILY_WEBHOOK_SECRET       (optional, but recommended — Daily generates
//                                 one for you in the webhook config UI)
//
// REQUIRES (Daily plan): recording + transcription must be ENABLED. After
// upgrading Daily to Growth, set these env vars in Supabase secrets:
//   * DAILY_ENABLE_RECORDING=true
//   * DAILY_ENABLE_TRANSCRIPTION=true
// The next booking will auto-enable both on its room (book-call EF reads them).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-daily-signature, x-webhook-signature, x-webhook-timestamp",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function escapeHtml(s: string): string {
    return String(s == null ? "" : s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;" }[c] as string));
}

async function verifyDailySig(req: Request, raw: string, secret: string): Promise<boolean> {
    const sig = req.headers.get("x-webhook-signature") || req.headers.get("x-daily-signature");
    const ts = req.headers.get("x-webhook-timestamp");
    if (!sig || !ts) return false;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const buf = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${raw}`));
    const computed = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    return computed === sig || ("v1," + computed) === sig;
}

async function fetchDailyTranscript(apiKey: string, transcriptId: string): Promise<string> {
    // Daily returns a download URL for the transcript JSON
    const r = await fetch(`https://api.daily.co/v1/transcripts/${transcriptId}`, {
        headers: { "Authorization": `Bearer ${apiKey}` },
    });
    if (!r.ok) throw new Error(`Daily transcript fetch ${r.status}`);
    const meta = await r.json();
    // The transcript JSON URL is at meta.url (signed S3-style URL)
    if (!meta.url) throw new Error("Daily transcript: no download URL");
    const r2 = await fetch(meta.url);
    if (!r2.ok) throw new Error(`Daily transcript download ${r2.status}`);
    const text = await r2.text();
    // Transcript is often a series of JSONL lines: {"text":"...", "speaker":"..."}
    try {
        const lines = text.split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
        return lines.map(l => `${l.speaker || "Speaker"}: ${l.text || ""}`).join("\n");
    } catch {
        return text;
    }
}

async function summarizeWithClaude(apiKey: string, transcript: string, calOwnerName: string, bookerName: string): Promise<{ summary: string; actionItems: string[] }> {
    const prompt = `You are summarizing a sales / customer-success call between ${calOwnerName} (LYMX team) and ${bookerName} (prospect/customer).

Produce a recap that ${calOwnerName} can read in 30 seconds when they follow up:

1) A 2-3 sentence summary of what was discussed and any decisions made.
2) Action items (bullet list, max 5). Each item starts with who owns it (LYMX or ${bookerName.split(/\s+/)[0]}) and what's the next step.
3) If the prospect's interest level is clear (hot / warm / cold), note it in one phrase.

Return STRICT JSON:
{
  "summary": "2-3 sentence recap...",
  "action_items": ["LYMX: send pricing PDF by Friday", "Brewer: confirm decision-maker availability"]
}

No preamble, no markdown, no code blocks. Just the JSON.

Transcript:
"""
${transcript.slice(0, 12000)}
"""`;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1024,
            messages: [{ role: "user", content: prompt }],
        }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}`);
    const j = await r.json();
    const content = (j.content?.[0]?.text || "").trim();
    // Try to extract JSON even if there's accidental wrapping
    const jsonMatch = content.match(/\{[\s\S]+\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    return {
        summary: parsed.summary || "(no summary generated)",
        actionItems: Array.isArray(parsed.action_items) ? parsed.action_items : [],
    };
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const DAILY_KEY = Deno.env.get("DAILY_API_KEY");
    const ANTHROPIC = Deno.env.get("ANTHROPIC_API_KEY");
    const WEBHOOK_SECRET = Deno.env.get("DAILY_WEBHOOK_SECRET");
    if (!SB_URL || !SB_KEY) return json({ ok: false, error: "Server config missing" }, 500);

    const raw = await req.text();
    if (WEBHOOK_SECRET) {
        const valid = await verifyDailySig(req, raw, WEBHOOK_SECRET);
        if (!valid) return json({ ok: false, error: "Bad signature" }, 403);
    }

    let payload: any;
    try { payload = JSON.parse(raw); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

    const supabase = createClient(SB_URL, SB_KEY);
    const eventType: string = payload.type || payload.event || "unknown";
    const data = payload.payload || payload.data || payload;

    // Daily room name (matches bookings.video_room_id)
    const roomName: string = data.room || data.room_name || data.meeting?.room_name || "";

    if (!roomName) {
        // Some payloads (like webhook ping/test) don't have a room — just ack
        return json({ ok: true, ignored: true, event: eventType });
    }

    // Look up the booking
    const { data: booking } = await supabase
        .from("bookings")
        .select("id, team_calendar_id, lead_id, summary, transcript, video_room_data")
        .eq("video_room_id", roomName)
        .maybeSingle();

    // Module 4: when no team-calendar booking matches the room name, fall back
    // to onboarding_bookings (the biz-onboarding flow uses the same Daily.co
    // webhook URL). On match: update status + completed_at + video_room_data,
    // optionally email host on a no-show. Return early — the heavy
    // team-calendar flow below (leads, conversations, transcript summary) is
    // not applicable to onboarding bookings.
    if (!booking) {
        const { data: onb } = await supabase
            .from("onboarding_bookings")
            .select("id, host_id, booker_name, booker_email, business_id, business_name, video_room_data")
            .eq("video_room_id", roomName)
            .maybeSingle();
        if (!onb) {
            return json({ ok: true, ignored: true, reason: "no booking with that room name", room: roomName });
        }

        if (eventType === "meeting.ended" || eventType === "room.meeting.ended") {
            const durationSec: number = Number(data.duration ?? data.session_duration ?? 0);
            const participantsRaw = data.participants ?? data.participant_data ?? null;
            const participantCount: number = Array.isArray(participantsRaw)
                ? participantsRaw.length
                : (typeof participantsRaw === "number" ? participantsRaw : (data.max_participants ?? 0));
            const isNoShow = (durationSec > 0 && durationSec < 60) || (participantCount > 0 && participantCount < 2);
            const newStatus = isNoShow ? "no_show" : "completed";

            await supabase.from("onboarding_bookings").update({
                status: newStatus,
                completed_at: new Date().toISOString(),
                video_room_data: { ...((onb as any).video_room_data || {}), meeting_ended_data: data },
            }).eq("id", (onb as any).id);

            // No-show: nudge the host so they can follow up. Booker no-shows on
            // onboarding calls usually mean a scheduling mistake — we want the
            // host to reach out manually rather than auto-rebooking.
            if (isNoShow) {
                const RESEND_KEY_NS = Deno.env.get("RESEND_API_KEY");
                const { data: host } = await supabase
                    .from("onboarding_hosts")
                    .select("display_name, email")
                    .eq("id", (onb as any).host_id)
                    .maybeSingle();
                if (RESEND_KEY_NS && host) {
                    const bizLabel = (onb as any).business_name || "—";
                    try {
                        await fetch("https://api.resend.com/emails", {
                            method: "POST",
                            headers: { "Authorization": `Bearer ${RESEND_KEY_NS}`, "Content-Type": "application/json" },
                            body: JSON.stringify({
                                from: "LYMX <kenny@lymxpower.com>",
                                to: [(host as any).email],
                                subject: `No-show on the LYMX onboarding call — ${(onb as any).booker_name}`,
                                html: `<p>Hi ${escapeHtml((host as any).display_name)},</p>
<p>The onboarding call with <strong>${escapeHtml((onb as any).booker_name)}</strong> &lt;${escapeHtml((onb as any).booker_email)}&gt;${bizLabel !== "—" ? " for <strong>" + escapeHtml(bizLabel) + "</strong>" : ""} ended without enough participants to count as a real call (duration ${durationSec}s, ${participantCount} participant${participantCount === 1 ? "" : "s"}).</p>
<p>Reach out directly to reschedule — they may have had a scheduling mistake.</p>
<p style="color:#5b6472;font-size:12.5px;margin-top:18px">— Automated message from LYMX Power onboarding</p>`,
                                reply_to: (onb as any).booker_email,
                            }),
                        });
                    } catch (e: any) { console.warn(`[call-summary] onboarding no-show email failed: ${e.message}`); }
                }
            }

            return json({
                ok: true,
                action: isNoShow ? "marked_no_show" : "marked_completed",
                booking_kind: "onboarding",
                booking_id: (onb as any).id,
                duration_sec: durationSec,
                participant_count: participantCount,
            });
        }

        // Transcript / recording events: stash the event payload on the
        // booking row for audit but skip the team-calendar transcript flow
        // (which is keyed off team_calendars + leads + conversations).
        const merged = { ...((onb as any).video_room_data || {}), [eventType]: data };
        await supabase.from("onboarding_bookings").update({ video_room_data: merged }).eq("id", (onb as any).id);
        return json({ ok: true, ignored: true, booking_kind: "onboarding", reason: "event_logged_only", event: eventType });
    }

    // Handle each event type
    if (eventType === "meeting.ended" || eventType === "room.meeting.ended") {
        // No-show detection: Daily.co payload includes `duration` (seconds) and
        // sometimes `participants` (array). If the call lasted <60s OR fewer
        // than 2 participants ever joined, treat it as a no-show.
        const durationSec: number = Number(data.duration ?? data.session_duration ?? 0);
        const participantsRaw = data.participants ?? data.participant_data ?? null;
        const participantCount: number = Array.isArray(participantsRaw)
            ? participantsRaw.length
            : (typeof participantsRaw === "number" ? participantsRaw : (data.max_participants ?? 0));
        const isNoShow = (durationSec > 0 && durationSec < 60) || (participantCount > 0 && participantCount < 2);

        const newStatus = isNoShow ? "no_show" : "completed";
        await supabase.from("bookings").update({
            status: newStatus,
            completed_at: new Date().toISOString(),
            video_room_data: { ...(booking.video_room_data || {}), meeting_ended_data: data },
        }).eq("id", booking.id);

        // If no-show, post a system message to the conversation thread + email the host
        if (isNoShow) {
            const { data: cal } = await supabase
                .from("team_calendars").select("user_id, handle, display_name, timezone")
                .eq("id", booking.team_calendar_id).maybeSingle();
            const { data: lead } = booking.lead_id
                ? await supabase.from("leads").select("conversation_id, full_name, email").eq("id", booking.lead_id).maybeSingle()
                : { data: null };
            if (lead?.conversation_id) {
                const startsLocal = new Date(booking.starts_at || Date.now()).toLocaleString("en-US", { timeZone: cal?.timezone || "UTC", dateStyle: "full", timeStyle: "short" });
                await supabase.from("conversation_messages").insert({
                    conversation_id: lead.conversation_id,
                    sender_user_id: null,
                    sender_type: "system",
                    sender_name_snapshot: "Booking",
                    channel: "system",
                    body: `🙁 No-show on ${startsLocal} (duration ${durationSec}s, ${participantCount} participant${participantCount === 1 ? "" : "s"}).`,
                    direction: "internal",
                });
            }

            // Email the host with rebook + mark-as-completed buttons
            const RESEND_KEY_NS = Deno.env.get("RESEND_API_KEY");
            if (RESEND_KEY_NS && cal) {
                const { data: ownerUser } = await supabase.auth.admin.getUserById(cal.user_id);
                const ownerEmail = ownerUser?.user?.email || `${cal.handle}@getlymx.com`;
                const ownerName = cal.display_name || "LYMX Team";
                const bookerName = lead?.full_name || "Guest";
                const bookerEmail = lead?.email || "";
                const rebookUrl = `https://getlymx.com/c/${cal.handle}`;
                const leadUrl = booking.lead_id ? `https://getlymx.com/leads.html?lead=${booking.lead_id}` : "https://getlymx.com/leads.html";
                const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#0e1116;max-width:600px;margin:0 auto;padding:24px">`
                  + `<h2 style="margin:0 0 12px;font-size:22px">🙁 Looks like ${escapeHtml(bookerName)} didn't show up</h2>`
                  + `<p>Hi ${escapeHtml(ownerName)},</p>`
                  + `<p>Your call with <b>${escapeHtml(bookerName)}</b>${bookerEmail ? ` &lt;${escapeHtml(bookerEmail)}&gt;` : ""} didn't have enough attendees to count as a real call. Could be a no-show, could be a tech issue.</p>`
                  + `<p style="margin-top:18px"><a href="${leadUrl}" style="display:inline-block;background:#0a84ff;color:#fff;padding:11px 22px;border-radius:9px;font-weight:700;text-decoration:none;margin-right:8px">📌 Open lead</a>`
                  + `<a href="${rebookUrl}" style="display:inline-block;background:#fff;color:#0e1116;border:1px solid #d1d5db;padding:11px 22px;border-radius:9px;font-weight:700;text-decoration:none">📅 Share rebook link</a></p>`
                  + `<hr style="border:0;border-top:1px solid #e6e8ec;margin:24px 0 14px" />`
                  + `<div style="font-size:12px;color:#5b6472">Automated detection — duration was ${durationSec}s, ${participantCount} participant${participantCount === 1 ? "" : "s"}. If this is wrong, you can flip the status back to Completed in the booking.</div>`
                  + `</div>`;
                try {
                    await fetch("https://api.resend.com/emails", {
                        method: "POST",
                        headers: { "Authorization": `Bearer ${RESEND_KEY_NS}`, "Content-Type": "application/json" },
                        body: JSON.stringify({
                            from: `LYMX <${ownerEmail}>`,
                            to: [ownerEmail],
                            subject: `No-show: ${bookerName}`,
                            html,
                            text: `Your call with ${bookerName} didn't have enough attendees. Duration ${durationSec}s, ${participantCount} participants. Open lead: ${leadUrl}`,
                            reply_to: bookerEmail || ownerEmail,
                        }),
                    });
                } catch (e: any) { console.warn(`[call-summary] no-show email failed: ${e.message}`); }
            }
        }
        return json({ ok: true, action: isNoShow ? "marked_no_show" : "marked_completed", booking_id: booking.id, duration_sec: durationSec, participant_count: participantCount });
    }

    if (
        eventType === "transcript.ready-to-download" ||
        eventType === "recording.ready-to-download" ||
        eventType === "transcript.ready" ||  // legacy name, kept for safety
        eventType === "recording.ready"      // legacy name, kept for safety
    ) {
        // Only run when we have a transcript_id (recording.ready alone doesn't include text)
        const transcriptId: string | undefined = data.transcript_id || data.id;
        if (!transcriptId || !DAILY_KEY || !ANTHROPIC) {
            // Save the event payload so we can investigate later
            const merged = { ...(booking.video_room_data || {}), [eventType]: data };
            await supabase.from("bookings").update({ video_room_data: merged }).eq("id", booking.id);
            return json({ ok: true, ignored: true, reason: "missing transcript_id or required API keys", event: eventType });
        }

        // Fetch transcript text
        let transcriptText: string;
        try { transcriptText = await fetchDailyTranscript(DAILY_KEY, transcriptId); }
        catch (e: any) { return json({ ok: false, error: "transcript fetch failed: " + e.message }, 500); }

        // Look up calendar owner + lead name for the summary prompt
        const { data: cal } = await supabase.from("team_calendars").select("display_name").eq("id", booking.team_calendar_id).single();
        const { data: lead } = booking.lead_id
            ? await supabase.from("leads").select("full_name, conversation_id").eq("id", booking.lead_id).maybeSingle()
            : { data: null };
        const ownerName = cal?.display_name || "Team member";
        const bookerName = lead?.full_name || "Guest";

        // Summarize with Claude
        let summary = "(transcript saved; summary unavailable)";
        let actionItems: string[] = [];
        try {
            const s = await summarizeWithClaude(ANTHROPIC, transcriptText, ownerName, bookerName);
            summary = s.summary;
            actionItems = s.actionItems;
        } catch (e: any) {
            console.warn(`[call-summary] Claude summary failed: ${e.message}`);
        }

        // Persist
        await supabase.from("bookings").update({
            transcript: transcriptText,
            summary,
            action_items: actionItems,
        }).eq("id", booking.id);

        // Post a system message into the conversation thread
        if (lead?.conversation_id) {
            const body = `📞 Call recap (${ownerName} ↔ ${bookerName})\n\n${summary}\n\n` +
                         (actionItems.length ? "Action items:\n" + actionItems.map(a => "• " + a).join("\n") : "");
            await supabase.from("conversation_messages").insert({
                conversation_id: lead.conversation_id,
                sender_user_id: null,
                sender_type: "system",
                sender_name_snapshot: "Call summary",
                channel: "system",
                body,
                direction: "internal",
            });
            // Bump lead.last_contacted_at + add summary preview to notes
            await supabase.from("leads").update({
                last_contacted_at: new Date().toISOString(),
                notes: summary.slice(0, 1000),
            }).eq("id", booking.lead_id);
        }

        return json({ ok: true, action: "summarized", booking_id: booking.id, summary_chars: summary.length, action_items_count: actionItems.length });
    }

    // Unknown / pass-through event — still ack so Daily doesn't retry
    return json({ ok: true, ignored: true, event: eventType });
});
