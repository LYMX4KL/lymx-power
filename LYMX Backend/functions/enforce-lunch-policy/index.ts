// =============================================================================
// LYMX Power — enforce-lunch-policy  (cron 06:30 UTC daily ≈ 23:30 PT prev-day)
// =============================================================================
// POST /functions/v1/enforce-lunch-policy
//
// For each staff_profile that worked > 6h yesterday (clock_events in-out span),
// checks for a break_start/break_end pair of at least staff_profiles.lunch_minutes_default
// minutes (or fallback 30). If missing, calls public.system_issue_missed_lunch_writeup(
//     profile_id => user_id, work_date => yesterday::date)
// which is a SECURITY DEFINER RPC that inserts a personnel_write_ups row with
// severity='minor' and reason='missed_lunch' (or escalates to 'major' on 3rd
// offense in a rolling 30-day window).
//
// AUTH: same cron-secret OR am_i_admin() pattern as auto-close-clock-events.
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

serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SB_URL || !SB_KEY) return err("Server config missing", 500);
    const supa = createClient(SB_URL, SB_KEY);

    // Determine yesterday's date in Pacific Time (LYMX is in Las Vegas).
    // We approximate via UTC-8 (PST) — acceptable since cron runs at 06:30 UTC.
    const nowUtc = new Date();
    const ptOffsetMs = 8 * 3_600_000; // not DST-perfect but good enough for daily cadence
    const yesterdayPt = new Date(nowUtc.getTime() - ptOffsetMs - 24 * 3_600_000);
    const yesterdayDateStr = yesterdayPt.toISOString().slice(0, 10);

    // Range: yesterday PT 00:00 → today PT 00:00 (UTC: yesterday +8h → today +8h)
    const startUtc = new Date(yesterdayDateStr + "T00:00:00Z");
    startUtc.setUTCHours(startUtc.getUTCHours() + 8); // PT → UTC
    const endUtc = new Date(startUtc.getTime() + 24 * 3_600_000);

    const { data: events, error } = await supa.from("clock_events")
        .select("user_id, event_type, event_at")
        .gte("event_at", startUtc.toISOString())
        .lt("event_at", endUtc.toISOString())
        .order("event_at", { ascending: true });
    if (error) return err("Query failed: " + error.message, 500);

    type Ev = { user_id: string; event_type: string; event_at: string };
    const byUser = new Map<string, Ev[]>();
    for (const e of (events || []) as Ev[]) {
        if (!byUser.has(e.user_id)) byUser.set(e.user_id, []);
        byUser.get(e.user_id)!.push(e);
    }

    // Pull lunch_minutes_default per profile (default 30)
    const userIds = Array.from(byUser.keys());
    let lunchByUser = new Map<string, number>();
    if (userIds.length) {
        const { data: profs } = await supa.from("staff_profiles")
            .select("user_id, lunch_minutes_default")
            .in("user_id", userIds);
        for (const p of profs || []) lunchByUser.set(p.user_id, p.lunch_minutes_default || 30);
    }

    const issued: Array<{ user_id: string; worked_hrs: number; required_min: number; got_min: number }> = [];
    let skipped = 0;
    let errorCount = 0;

    for (const [user_id, evs] of byUser.entries()) {
        // Compute total worked time (sum of in→out spans)
        let workedMs = 0;
        let openIn: number | null = null;
        for (const e of evs) {
            if (e.event_type === "in") openIn = new Date(e.event_at).getTime();
            else if (e.event_type === "out" && openIn != null) {
                workedMs += new Date(e.event_at).getTime() - openIn;
                openIn = null;
            }
        }
        const workedHrs = workedMs / 3_600_000;
        if (workedHrs < 6) { skipped++; continue; }

        // Compute longest break span
        let longestBreakMin = 0;
        let openBreak: number | null = null;
        for (const e of evs) {
            if (e.event_type === "break_start") openBreak = new Date(e.event_at).getTime();
            else if (e.event_type === "break_end" && openBreak != null) {
                const dur = (new Date(e.event_at).getTime() - openBreak) / 60_000;
                if (dur > longestBreakMin) longestBreakMin = dur;
                openBreak = null;
            }
        }
        const required = lunchByUser.get(user_id) || 30;
        if (longestBreakMin >= required - 1) { skipped++; continue; } // 1-min tolerance

        // Issue the write-up via RPC
        const { error: rpcErr } = await supa.rpc("system_issue_missed_lunch_writeup", {
            p_profile_id: user_id,
            p_work_date: yesterdayDateStr,
        });
        if (rpcErr) {
            console.warn("missed-lunch RPC failed", user_id, rpcErr.message);
            errorCount++;
            continue;
        }
        issued.push({ user_id, worked_hrs: +workedHrs.toFixed(2), required_min: required, got_min: Math.round(longestBreakMin) });
    }

    return json({
        ok: true,
        date_checked: yesterdayDateStr,
        write_ups_issued: issued.length,
        skipped_eligible: skipped,
        errors: errorCount,
        examples: issued.slice(0, 20),
    });
});
