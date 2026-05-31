// =============================================================================
// LYMX — pull-business-transactions   (the generic read-pull connector)
//   POST /functions/v1/pull-business-transactions   { business_id, dry_run?, limit? }
// =============================================================================
// Pulls a member business's read-only transaction feed (business_integration_source),
// and routes each eligible transaction through the live business-event engine, so
// catalog rates, idempotency (external_ref), wallet matching, and the fraud guard
// all apply unchanged. Generic — works for ANY business that exposes the feed
// contract: GET <url>?since=<ISO> -> [{ transaction_id, occurred_at, type, amount, customer_ref }].
//
//   dry_run: true  -> fetch + return a sample, DO NOT issue (used to discover the
//                     business's exact `type` strings + customer_ref format).
//   dry_run: false -> issue via business-event, advance the cursor.
//
// Deploy with verify_jwt = FALSE. Admin-driven (and pg_cron-driven later).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function classifyIdentifier(ref: string): { email?: string; phone?: string; external_id?: string } {
    const v = (ref || "").trim();
    if (!v) return {};
    if (v.includes("@")) return { email: v.toLowerCase() };
    if (/^[+]?[\d][\d\s\-().]{6,}$/.test(v)) return { phone: v };
    return { external_id: v };
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

    const SB_URL = Deno.env.get("SUPABASE_URL");
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SB_URL || !SB_KEY) return json({ ok: false, error: "server_misconfigured" }, 500);
    const supabase = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

    let body: any;
    try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
    const businessId = (body?.business_id || "").trim();
    const dryRun = body?.dry_run === true;
    const cap = Math.min(Number(body?.limit || 500), 1000);
    if (!businessId) return json({ ok: false, error: "missing_business_id" }, 400);

    const { data: biz } = await supabase.from("businesses")
        .select("id, slug, api_key, integration_active, intake_completed_at")
        .eq("id", businessId).maybeSingle();
    if (!biz) return json({ ok: false, error: "business_not_found" }, 404);
    if (!biz.integration_active || !biz.intake_completed_at)
        return json({ ok: false, error: "business_not_active" }, 403);

    const { data: src } = await supabase.from("business_integration_source")
        .select("source_url, auth_header, auth_scheme, auth_token, since_cursor, active")
        .eq("business_id", businessId).maybeSingle();
    if (!src || !src.active) return json({ ok: false, error: "no_active_source" }, 400);
    if (!src.auth_token) return json({ ok: false, error: "source_token_not_set" }, 400);

    // ── fetch the business's feed since the cursor ─────────────────────────
    const sep = src.source_url.includes("?") ? "&" : "?";
    const feedUrl = src.source_url + sep + "since=" + encodeURIComponent(src.since_cursor);
    let txns: any[];
    try {
        const fr = await fetch(feedUrl, { headers: { [src.auth_header]: (src.auth_scheme || "Bearer") + " " + src.auth_token } });
        if (!fr.ok) return json({ ok: false, error: "feed_fetch_failed", http: fr.status, detail: (await fr.text()).slice(0, 200) }, 502);
        const parsed = await fr.json();
        txns = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.transactions) ? parsed.transactions : []);
    } catch (e) {
        return json({ ok: false, error: "feed_unreachable", detail: (e as Error).message }, 502);
    }

    if (dryRun) {
        return json({
            ok: true, dry_run: true, fetched: txns.length,
            sample: txns.slice(0, 5),
            note: "No LYMX issued. Use these exact `type` values to seed business_event_catalog, and confirm customer_ref format.",
        });
    }

    // ── issue each txn through the canonical engine ────────────────────────
    const EF = SB_URL + "/functions/v1/business-event";
    const counts: Record<string, number> = { issued: 0, no_wallet: 0, rejected: 0, hold: 0, error: 0 };
    const results: any[] = [];
    let maxTs = src.since_cursor;
    for (const t of txns.slice(0, cap)) {
        const ext = String(t.transaction_id ?? t.id ?? "").trim();
        const type = String(t.type ?? "").trim();
        const amount = Number(t.amount ?? 0);
        const occurredAt = t.occurred_at ?? t.date ?? null;
        const cust = classifyIdentifier(String(t.customer_ref ?? t.customer ?? ""));
        if (!ext || !type) { counts.error++; results.push({ ext, error: "missing_txn_id_or_type" }); continue; }

        let outcome: any;
        try {
            const r = await fetch(EF, {
                method: "POST",
                headers: { "Content-Type": "application/json", "apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY, "x-lymx-api-key": biz.api_key },
                body: JSON.stringify({ event_type: type, amount_usd: amount, customer: cust, external_ref: ext, occurred_at: occurredAt }),
            });
            outcome = await r.json().catch(() => ({}));
        } catch (e) { outcome = { error: "engine_unreachable", detail: (e as Error).message }; }

        const status = outcome?.status || (outcome?.error ? "rejected" : "error");
        if (status === "issued") counts.issued++;
        else if (status === "no_wallet") counts.no_wallet++;
        else if (status === "hold") counts.hold++;
        else if (outcome?.error) counts.rejected++;
        else counts.error++;
        results.push({ ext, type, amount, status, lymx: outcome?.lymx_issued ?? 0, error: outcome?.error });

        if (occurredAt && (!maxTs || new Date(occurredAt) > new Date(maxTs))) maxTs = occurredAt;
    }

    // advance the cursor (idempotent: business-event dedupes on external_ref anyway)
    await supabase.from("business_integration_source")
        .update({ since_cursor: maxTs, last_pulled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("business_id", businessId);

    return json({ ok: true, fetched: txns.length, processed: Math.min(txns.length, cap), counts, new_cursor: maxTs, results: results.slice(0, 25) });
});
