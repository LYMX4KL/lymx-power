// =============================================================================
// LYMX Power — Google Calendar busy times (for slot filtering)
// =============================================================================
// POST /functions/v1/google-busy
//
// Returns busy time ranges for a team member, pulled from their connected
// Google Calendar via the freebusy API. The booking page calls this when
// rendering available slots and filters out anything that overlaps.
//
// REQUEST BODY:
//   { handle: "kenny", from: "ISO date", to: "ISO date" }
//
// RESPONSE:
//   { ok: true, busy: [{ start: "ISO", end: "ISO" }, ...], synced: true|false }
//
// If the team member hasn't connected Google Calendar, returns synced:false
// and an empty busy list (booking proceeds without filtering).
//
// Auto-refreshes expired access tokens using refresh_token.
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

// Refresh an access token using the refresh_token grant. Returns the new
// access_token + new expires_at; persists them to oauth_tokens.
async function refreshGoogleToken(supabase: ReturnType<typeof createClient>, tokenRow: any): Promise<{ access_token: string; expires_at: string } | null> {
    const CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!;
    const CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")!;
    if (!tokenRow.refresh_token) return null;
    const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: tokenRow.refresh_token,
            grant_type: "refresh_token",
        }).toString(),
    });
    if (!r.ok) {
        const errText = await r.text().catch(() => "");
        console.warn(`[google-busy] refresh failed: ${r.status} ${errText}`);
        // 400 invalid_grant / 401 = user revoked the refresh_token in Google.
        // Mark the row as revoked so team-calendar.html shows "Reconnect required"
        // and book-call's google push skips this token going forward.
        if (r.status === 400 || r.status === 401) {
            await supabase.from("oauth_tokens").update({ status: "revoked" }).eq("id", tokenRow.id);
        }
        return null;
    }
    const j = await r.json();
    const expiresAt = j.expires_in ? new Date(Date.now() + j.expires_in * 1000).toISOString() : null;
    await supabase.from("oauth_tokens").update({
        access_token: j.access_token,
        expires_at: expiresAt,
        last_refreshed_at: new Date().toISOString(),
    }).eq("id", tokenRow.id);
    return { access_token: j.access_token, expires_at: expiresAt || "" };
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return err("Method not allowed", 405);

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SB_URL || !SB_KEY) return err("Server config missing", 500);
    const supabase = createClient(SB_URL, SB_KEY);

    let body: any;
    try { body = await req.json(); } catch { return err("Invalid JSON", 400); }
    const { handle, from, to } = body;
    if (!handle || !from || !to) return err("handle, from, to are required", 400);

    // Resolve the calendar owner
    const { data: cal } = await supabase.from("team_calendars").select("user_id").eq("handle", handle).eq("is_active", true).maybeSingle();
    if (!cal) return json({ ok: true, busy: [], synced: false, reason: "calendar not found" });

    // Look up their Google token
    const { data: tokenRow } = await supabase.from("oauth_tokens").select("*").eq("user_id", cal.user_id).eq("provider", "google").maybeSingle();
    if (!tokenRow || !tokenRow.pull_busy) return json({ ok: true, busy: [], synced: false, reason: "user has not connected Google or has pull_busy=off" });
    if (tokenRow.status === "revoked") return json({ ok: true, busy: [], synced: false, reason: "google_token_revoked" });

    // Refresh if expired
    let accessToken = tokenRow.access_token;
    if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date(Date.now() + 30 * 1000)) {
        const refreshed = await refreshGoogleToken(supabase, tokenRow);
        if (refreshed) accessToken = refreshed.access_token;
        else return json({ ok: true, busy: [], synced: false, reason: "token expired and refresh failed" });
    }

    // Hit Google freebusy
    const r = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            timeMin: from,
            timeMax: to,
            items: [{ id: "primary" }],
        }),
    });
    if (!r.ok) {
        const t = await r.text().catch(() => "");
        return json({ ok: true, busy: [], synced: false, reason: `freebusy failed: ${r.status} ${t.slice(0, 200)}` });
    }
    const fb = await r.json();
    const busy = (fb.calendars?.primary?.busy || []).map((b: any) => ({ start: b.start, end: b.end }));

    await supabase.from("oauth_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", tokenRow.id);

    return json({ ok: true, busy, synced: true });
});
