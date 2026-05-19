// =============================================================================
// LYMX Power — auto-close-clock-events  (cron 07:00 UTC daily ≈ 00:00 PT)
// =============================================================================
// POST /functions/v1/auto-close-clock-events
//
// Finds open clock-in events (no matching clock-out within 16h) from
// yesterday's punches and auto-inserts a synthetic clock-out at +8h (or
// scheduled end_at when available). The auto-closed events get a notes flag
// of "auto_closed:reason" so HR can review them in admin-personnel-records.
//
// AUTH: relies on Supabase Functions JWT verification — pg_cron calls with
// the service-role bearer token, which Supabase verifies before the EF runs.
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
    // Look back 36h to be safe across DST + late punches
    const cutoff = new Date();
    cutoff.setUTCHours(cutoff.getUTCHours() - 36);

    // Pull all clock events in the window; we'll pair them client-side per user.
    const { data: events, error } = await supa.from("clock_events")
        .select("id, user_id, event_type, event_at, notes")
        .gte("event_at", cutoff.toISOString())
        .order("event_at", { ascending: true });
    if (error) return err("Query failed: " + error.message, 500);

    type Ev = { id: string; user_id: string; event_type: string; event_at: string; notes: string | null };
    const byUser = new Map<string, Ev[]>();
    for (const e of (events || []) as Ev[]) {
        if (!byUser.has(e.user_id)) byUser.set(e.user_id, []);
        byUser.get(e.user_id)!.push(e);
    }

    let closed = 0;
    const autoClosedSummaries: Array<{ user_id: string; opened_at: string; closed_at: string }> = [];
    const nowMs = Date.now();

    for (const [user_id, evs] of byUser.entries()) {
        // Walk in time order. Find each 'in' that has no matching 'out' within 16h.
        for (let i = 0; i < evs.length; i++) {
            const ev = evs[i];
            if (ev.event_type !== "in") continue;
            // Look ahead for next 'out' or 'in' (a new 'in' means the previous one is orphaned)
            let matched = false;
            for (let j = i + 1; j < evs.length; j++) {
                if (evs[j].event_type === "out") { matched = true; break; }
                if (evs[j].event_type === "in") break; // orphan
            }
            if (matched) continue;

            // Is this event older than 16h? If so, auto-close.
            const openedAt = new Date(ev.event_at).getTime();
            const ageHr = (nowMs - openedAt) / 3_600_000;
            if (ageHr < 16) continue;

            // Auto-close 8h after the open (or now, whichever is earlier — never future)
            const closeAtMs = Math.min(openedAt + 8 * 3_600_000, nowMs);
            const closeAt = new Date(closeAtMs).toISOString();

            const { error: insErr } = await supa.from("clock_events").insert({
                user_id,
                event_type: "out",
                event_at: closeAt,
                geofence_pass: false,
                remote_allowed_at_event: false,
                notes: `auto_closed:no_matching_out_within_16h (paired with ${ev.id})`,
            });
            if (insErr) {
                console.warn("auto-close insert failed", user_id, insErr.message);
                continue;
            }
            closed++;
            autoClosedSummaries.push({ user_id, opened_at: ev.event_at, closed_at: closeAt });
        }
    }

    return json({ ok: true, auto_closed: closed, examples: autoClosedSummaries.slice(0, 20) });
});
