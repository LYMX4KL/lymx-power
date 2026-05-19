// =============================================================================
// LYMX Power — end-of-shift-reminder  (cron every 30 min during work hours)
// =============================================================================
// POST /functions/v1/end-of-shift-reminder
//
// Finds staff who are still clocked-in but past their scheduled shift end_at
// (per schedule_shifts on today's date). Sends a single SMS reminder via the
// sms-send EF. Tracks reminders in a deduped fashion (notes-suffix on the
// last clock-in event) so we never spam the same shift twice.
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

const REMIND_TAG = "[shift_end_reminded]";

serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SB_URL || !SB_KEY) return err("Server config missing", 500);
    const supa = createClient(SB_URL, SB_KEY);

    // Today in PT (UTC-8 fixed-offset is fine for a per-30-min cron)
    const ptOffsetMs = 8 * 3_600_000;
    const ptNow = new Date(Date.now() - ptOffsetMs);
    const today = ptNow.toISOString().slice(0, 10);

    // Pull today's shifts
    const { data: shifts, error: sErr } = await supa.from("schedule_shifts")
        .select("user_id, shift_date, starts_at, ends_at")
        .eq("shift_date", today);
    if (sErr) return err("shifts query failed: " + sErr.message, 500);

    if (!shifts || !shifts.length) return json({ ok: true, reminders_sent: 0, reason: "no shifts today" });

    // Pull last 24h of clock events for these users
    const userIds = shifts.map(s => s.user_id);
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const { data: events, error: eErr } = await supa.from("clock_events")
        .select("id, user_id, event_type, event_at, notes")
        .in("user_id", userIds)
        .gte("event_at", since)
        .order("event_at", { ascending: true });
    if (eErr) return err("clock_events query failed: " + eErr.message, 500);

    // Bucket by user
    type Ev = { id: string; user_id: string; event_type: string; event_at: string; notes: string | null };
    const byUser = new Map<string, Ev[]>();
    for (const e of (events || []) as Ev[]) {
        if (!byUser.has(e.user_id)) byUser.set(e.user_id, []);
        byUser.get(e.user_id)!.push(e);
    }

    let sent = 0;
    const skipped: string[] = [];

    for (const shift of shifts) {
        const evs = byUser.get(shift.user_id) || [];
        // Find latest open 'in' (no matching 'out' after)
        let openIn: Ev | null = null;
        for (let i = evs.length - 1; i >= 0; i--) {
            if (evs[i].event_type === "in") { openIn = evs[i]; break; }
            if (evs[i].event_type === "out") break;
        }
        if (!openIn) { skipped.push(shift.user_id + ":not_clocked_in"); continue; }
        if ((openIn.notes || "").includes(REMIND_TAG)) { skipped.push(shift.user_id + ":already_reminded"); continue; }

        // Is now past shift end_at + 15 min grace?
        // shift.ends_at is a TIME like "17:00:00". Combine with shift.shift_date (date) in PT.
        const endHMS = String(shift.ends_at).split(":");
        const endPt = new Date(shift.shift_date + "T00:00:00Z");
        endPt.setUTCHours(parseInt(endHMS[0] || "0") + 8, parseInt(endHMS[1] || "0") + 15, 0, 0);
        if (Date.now() < endPt.getTime()) { skipped.push(shift.user_id + ":not_yet_past_end"); continue; }

        // Send SMS via sms-send EF. Lookup phone from staff_profiles.
        const { data: prof } = await supa.from("staff_profiles")
            .select("phone, full_name")
            .eq("user_id", shift.user_id).maybeSingle();
        const phone = prof?.phone;
        if (!phone) { skipped.push(shift.user_id + ":no_phone"); continue; }

        try {
            const r = await fetch(SB_URL + "/functions/v1/sms-send", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SB_KEY}`, "apikey": SB_KEY },
                body: JSON.stringify({
                    to: phone,
                    body: `Hi ${(prof.full_name || "").split(" ")[0] || "team"} — your shift ended at ${shift.ends_at.slice(0,5)} but you're still clocked in. Open LYMX → Clock to clock out, or your time will be auto-closed at midnight.`,
                }),
            });
            if (r.ok) {
                // Tag this clock-in so we don't re-remind
                await supa.from("clock_events").update({
                    notes: (openIn.notes || "") + " " + REMIND_TAG,
                }).eq("id", openIn.id);
                sent++;
            } else {
                skipped.push(shift.user_id + ":sms_failed_" + r.status);
            }
        } catch (e) {
            skipped.push(shift.user_id + ":sms_exception");
            console.warn("sms-send failed", shift.user_id, e);
        }
    }

    return json({ ok: true, reminders_sent: sent, skipped: skipped.slice(0, 30) });
});
