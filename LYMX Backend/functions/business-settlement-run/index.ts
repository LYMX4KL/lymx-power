// =============================================================================
// LYMX Power — Business Settlement Run (Sprint 1)
// =============================================================================
// POST /functions/v1/business-settlement-run
//
// Computes business_settlements rows for one business (or all approved
// businesses) over a calendar period. Per master-faq.html, the canonical
// cadence is monthly, with the actual ACH on the 5th business day of the
// following month. This EF runs the COMPUTE step only — writes pending rows
// to public.business_settlements via fn_compute_business_settlement().
//
// The Stripe-leg (transfers.create for net > 0, invoice.create for net < 0)
// is intentionally NOT here. It will live in a separate
// business-settlement-execute EF, gated by app_config.stripe_connect_enabled
// AND by admin approval on each pending row. This separation guarantees that
// no money moves without an explicit admin click — see ARCHITECTURE-RULES
// Rule 0 ("never band-aid; the safe path is the only path") and the
// "Financial actions" section of the operator policy.
//
// AUTH: service_role (cron trigger) OR admin JWT (manual run). Customer /
//       business-owner / partner JWTs are rejected with 403.
//
// REQUEST BODY (JSON, all optional):
//   {
//     "business_id":  "uuid",            // optional — if set, only this biz
//     "period_start": "2026-04-01",      // YYYY-MM-DD, inclusive (default: previous calendar month start)
//     "period_end":   "2026-05-01",      // YYYY-MM-DD, exclusive (default: previous calendar month end)
//     "dry_run":      false              // optional — if true, log but skip writes
//   }
//
// RESPONSE (200):
//   {
//     "ok": true,
//     "period_start": "2026-04-01",
//     "period_end":   "2026-05-01",
//     "settlements_computed": 12,
//     "settlements_skipped_existing": 3,
//     "settlements_skipped_zero":     2,
//     "total_pending_payout_cents":   85420,    // sum(net_cents) where net > 0
//     "total_pending_charge_cents":   12340,    // -sum(net_cents) where net < 0
//     "rows": [
//       { "business_id": "uuid", "settlement_id": "uuid", "net_cents": 4250,
//         "status": "pending", "lymx_issued": 12000, "lymx_redeemed": 3000 },
//       ...
//     ],
//     "dry_run": false
//   }
//
// IDEMPOTENCY: fn_compute_business_settlement is idempotent on
//   (business_id, period_end). Re-running the same period returns existing
//   rows untouched; only missing rows are inserted. Safe to retry.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// ---- CORS + response helpers ------------------------------------------------
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
const errorResponse = (message: string, status = 400) =>
    jsonResponse({ ok: false, error: message }, status);

// ---- JWT helpers ------------------------------------------------------------
function decodeJwt(jwt: string): Record<string, unknown> | null {
    try {
        const parts = jwt.split(".");
        if (parts.length !== 3) return null;
        return JSON.parse(
            atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
        );
    } catch {
        return null;
    }
}
function jwtRole(jwt: string): string | null {
    const p = decodeJwt(jwt);
    return p ? ((p["role"] as string) ?? null) : null;
}
function jwtSub(jwt: string): string | null {
    const p = decodeJwt(jwt);
    return p ? ((p["sub"] as string) ?? null) : null;
}

// ---- Period helpers ---------------------------------------------------------
// Returns the previous calendar month [start, end) as ISO date strings
// (YYYY-MM-DD). Both are UTC-anchored to avoid timezone drift on the 1st.
function previousCalendarMonth(): { start: string; end: string } {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth(); // 0-indexed; current month
    // Previous month start = year, month - 1, day 1
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    // Previous month end = year, month, day 1 (i.e. this month's first day)
    const endDate = new Date(Date.UTC(year, month, 1));
    const toIso = (d: Date) => d.toISOString().slice(0, 10);
    return { start: toIso(startDate), end: toIso(endDate) };
}

interface RunBody {
    business_id?: string;
    period_start?: string;
    period_end?: string;
    dry_run?: boolean;
}

// ---- Main handler -----------------------------------------------------------
serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
        return errorResponse("Method not allowed", 405);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
        return errorResponse("Missing Authorization header", 401);
    }
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const role = jwtRole(token);
    const callerUid = jwtSub(token);

    // Authorization: service_role (cron) OR admin (manual). Anything else is
    // rejected. The "admin" check uses the public.am_i_admin() RPC after we
    // build a supabase client with the caller's JWT so RLS applies.
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
        return errorResponse("Server misconfiguration: SUPABASE_URL / SERVICE_ROLE_KEY missing", 500);
    }

    let isAdmin = false;
    if (role === "service_role") {
        isAdmin = true; // cron trigger — full trust
    } else if (callerUid) {
        // Admin JWT check — use a client stamped with the caller's token so
        // public.am_i_admin() sees auth.uid() correctly.
        const callerClient = createClient(supabaseUrl, serviceKey, {
            global: { headers: { Authorization: `Bearer ${token}` } },
            auth:   { persistSession: false },
        });
        const { data, error } = await callerClient.rpc("am_i_admin");
        if (error) {
            return errorResponse(`Admin check failed: ${error.message}`, 500);
        }
        isAdmin = data === true;
    }

    if (!isAdmin) {
        return errorResponse(
            "Forbidden: business-settlement-run requires admin or service_role",
            403,
        );
    }

    // Parse body
    let body: RunBody = {};
    try {
        if (req.headers.get("content-type")?.includes("application/json")) {
            body = await req.json();
        }
    } catch {
        return errorResponse("Invalid JSON body", 400);
    }

    // Default to previous calendar month if dates not provided
    const defaultPeriod = previousCalendarMonth();
    const periodStart = body.period_start ?? defaultPeriod.start;
    const periodEnd   = body.period_end   ?? defaultPeriod.end;
    const dryRun      = body.dry_run === true;

    // Validate dates
    const startDt = new Date(periodStart + "T00:00:00Z");
    const endDt   = new Date(periodEnd   + "T00:00:00Z");
    if (isNaN(startDt.getTime()) || isNaN(endDt.getTime())) {
        return errorResponse("period_start / period_end must be YYYY-MM-DD", 400);
    }
    if (endDt <= startDt) {
        return errorResponse("period_end must be after period_start", 400);
    }

    // Service-role client for the actual writes
    const supabase = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false },
    });

    // Resolve the list of businesses to compute
    let targetBusinesses: { id: string; display_name: string | null }[] = [];
    if (body.business_id) {
        const { data, error } = await supabase
            .from("businesses")
            .select("id, display_name")
            .eq("id", body.business_id)
            .limit(1);
        if (error) return errorResponse(`Business lookup failed: ${error.message}`, 500);
        if (!data || !data.length) return errorResponse(`Business ${body.business_id} not found`, 404);
        targetBusinesses = data;
    } else {
        const { data, error } = await supabase
            .from("businesses")
            .select("id, display_name")
            .eq("approval_status", "approved");
        if (error) return errorResponse(`Business list failed: ${error.message}`, 500);
        targetBusinesses = data ?? [];
    }

    if (targetBusinesses.length === 0) {
        return jsonResponse({
            ok: true,
            period_start: periodStart,
            period_end:   periodEnd,
            settlements_computed: 0,
            settlements_skipped_existing: 0,
            settlements_skipped_zero: 0,
            total_pending_payout_cents: 0,
            total_pending_charge_cents: 0,
            rows: [],
            dry_run: dryRun,
            note: "No approved businesses to settle.",
        });
    }

    // Per-business compute
    let computed = 0;
    let skippedExisting = 0;
    let skippedZero = 0;
    let totalPayout = 0;
    let totalCharge = 0;
    const rows: Array<Record<string, unknown>> = [];

    for (const biz of targetBusinesses) {
        // Pre-check existence so we can distinguish "new compute" from "existing".
        const { data: existing, error: exErr } = await supabase
            .from("business_settlements")
            .select("id, status, net_cents")
            .eq("business_id", biz.id)
            .eq("period_end",  periodEnd)
            .maybeSingle();
        if (exErr) {
            console.warn(`[business-settlement-run] ${biz.id}: existing lookup failed`, exErr.message);
            continue;
        }
        if (existing) {
            skippedExisting++;
            rows.push({
                business_id:   biz.id,
                business_name: biz.display_name,
                settlement_id: existing.id,
                status:        existing.status,
                net_cents:     existing.net_cents,
                note:          "already-computed",
            });
            continue;
        }

        if (dryRun) {
            // Just report what WOULD happen — no write
            rows.push({
                business_id:   biz.id,
                business_name: biz.display_name,
                note:          "dry-run: would compute",
            });
            computed++;
            continue;
        }

        // Real compute via the SECURITY DEFINER RPC
        const { data: row, error: rpcErr } = await supabase.rpc(
            "fn_compute_business_settlement",
            {
                p_business_id:  biz.id,
                p_period_start: periodStart,
                p_period_end:   periodEnd,
            }
        );
        if (rpcErr) {
            console.warn(`[business-settlement-run] ${biz.id}: RPC failed`, rpcErr.message);
            rows.push({
                business_id:   biz.id,
                business_name: biz.display_name,
                error:         rpcErr.message,
            });
            continue;
        }

        // fn_compute_business_settlement returns the row directly
        const settlement = row as {
            id: string;
            status: string;
            net_cents: number;
            lymx_issued: number;
            lymx_redeemed: number;
            usd_owed_by_cents: number;
            usd_owed_to_cents: number;
        };

        if (settlement.status === "skipped_zero") {
            skippedZero++;
        } else {
            computed++;
            if (settlement.net_cents > 0) totalPayout += settlement.net_cents;
            if (settlement.net_cents < 0) totalCharge += -settlement.net_cents;
        }

        rows.push({
            business_id:        biz.id,
            business_name:      biz.display_name,
            settlement_id:      settlement.id,
            status:             settlement.status,
            net_cents:          settlement.net_cents,
            lymx_issued:        settlement.lymx_issued,
            lymx_redeemed:      settlement.lymx_redeemed,
            usd_owed_by_cents:  settlement.usd_owed_by_cents,
            usd_owed_to_cents:  settlement.usd_owed_to_cents,
        });
    }

    return jsonResponse({
        ok: true,
        period_start: periodStart,
        period_end:   periodEnd,
        settlements_computed: computed,
        settlements_skipped_existing: skippedExisting,
        settlements_skipped_zero: skippedZero,
        total_pending_payout_cents: totalPayout,
        total_pending_charge_cents: totalCharge,
        rows,
        dry_run: dryRun,
    });
});
