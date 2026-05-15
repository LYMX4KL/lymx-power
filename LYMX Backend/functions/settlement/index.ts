// =============================================================================
// LYMX Power — Settlement Endpoint (weekly partner payouts)
// =============================================================================
// POST /functions/v1/settlement
//
// Bundles unpaid partner_commissions for a date range into payable
// settlement batches — one settlement row per partner. Designed to be
// triggered weekly (Sunday → Saturday window).
//
// AUTH: service_role ONLY. This is an admin / scheduled-job endpoint.
//   Customer/biz-owner JWTs are rejected with 403.
//
// REQUEST BODY (JSON):
// {
//   "period_start": "2026-04-26",      // inclusive (YYYY-MM-DD)
//   "period_end":   "2026-05-02",      // exclusive
//   "partner_id":   "uuid",            // optional — if set, settle only this partner
//   "dry_run":      false              // optional — if true, compute but don't write
// }
//
// RESPONSE (200):
// {
//   "settlements_created": 4,
//   "total_amount":        2150.00,
//   "settlements": [
//     { "partner_id": "uuid", "settlement_id": "uuid",
//       "amount": 750, "commission_count": 3 },
//     ...
//   ],
//   "dry_run": false
// }
//
// IDEMPOTENCY: A commission row gets `settlement_id` set when it's bundled.
//   Re-running the same period only picks up commissions that are still
//   `settlement_id IS NULL` — already-bundled rows are skipped.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// --- CORS + response helpers -----------------------------------------------
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
    jsonResponse({ error: message }, status);

interface SettlementBody {
    period_start: string;
    period_end: string;
    partner_id?: string;
    dry_run?: boolean;
}

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
    const token = authHeader.replace("Bearer ", "");

    // Service-role gate — settlement is admin-only.
    // Decode the JWT and check the `role` claim. We can't string-compare against
    // SUPABASE_SERVICE_ROLE_KEY because Supabase's Edge Function gateway can
    // re-stamp the Authorization header, so the token we see may differ from
    // the literal key the caller sent.
    const getRole = (jwt: string): string | null => {
        try {
            const parts = jwt.split(".");
            if (parts.length !== 3) return null;
            const payload = JSON.parse(
                atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
            );
            return payload.role ?? null;
        } catch {
            return null;
        }
    };
    const role = getRole(token);
    if (role !== "service_role") {
        return errorResponse(
            "Forbidden: settlement is service-role only",
            403
        );
    }

    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } }
    );

    let body: SettlementBody;
    try {
        body = await req.json();
    } catch {
        return errorResponse("Invalid JSON", 400);
    }
    if (!body.period_start || !body.period_end) {
        return errorResponse("period_start and period_end are required (YYYY-MM-DD)", 400);
    }
    // Validate date format and ordering
    const start = new Date(body.period_start);
    const end = new Date(body.period_end);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return errorResponse("period_start / period_end must be valid dates", 400);
    }
    if (end <= start) {
        return errorResponse("period_end must be after period_start", 400);
    }

    const dryRun = body.dry_run === true;

    // Step 1: gather unpaid commissions in the period
    let query = supabase
        .from("partner_commissions")
        .select("id, partner_id, amount, type, source_business_id, source_partner_id, generation, created_at")
        .is("settlement_id", null)
        .gte("created_at", start.toISOString())
        .lt("created_at", end.toISOString());
    if (body.partner_id) {
        query = query.eq("partner_id", body.partner_id);
    }
    const { data: commissions, error: cErr } = await query;
    if (cErr) {
        return errorResponse(`Commission lookup failed: ${cErr.message}`, 500);
    }
    if (!commissions || commissions.length === 0) {
        return jsonResponse({
            settlements_created: 0,
            total_amount: 0,
            settlements: [],
            dry_run: dryRun,
            note: "No unpaid commissions in this period",
        });
    }

    // Step 2: group by partner_id, sum amount
    const byPartner = new Map<string, { amount: number; count: number; ids: string[] }>();
    for (const c of commissions) {
        const key = c.partner_id;
        if (!byPartner.has(key)) {
            byPartner.set(key, { amount: 0, count: 0, ids: [] });
        }
        const bucket = byPartner.get(key)!;
        bucket.amount += Number(c.amount);
        bucket.count += 1;
        bucket.ids.push(c.id);
    }

    // Step 3: dry-run short-circuit
    if (dryRun) {
        const settlements = Array.from(byPartner.entries()).map(([partner_id, b]) => ({
            partner_id,
            settlement_id: null,
            amount: Number(b.amount.toFixed(2)),
            commission_count: b.count,
        }));
        const totalAmount = settlements.reduce((s, x) => s + x.amount, 0);
        return jsonResponse({
            settlements_created: settlements.length,
            total_amount: Number(totalAmount.toFixed(2)),
            settlements,
            dry_run: true,
        });
    }

    // Step 4: write a settlement row per partner, then link commissions
    const results: Array<{
        partner_id: string;
        settlement_id: string;
        amount: number;
        commission_count: number;
    }> = [];

    const blockedUnverified: Array<{ partner_id: string; reason: string }> = [];
    for (const [partnerId, bucket] of byPartner.entries()) {
        // GATE: per Kenny 2026-05-14, do not pay out commission to unverified
        // Partners. They sign up freely; verification (ID check / W-9 / W-8BEN)
        // is required only before money moves.
        const { data: pRow } = await supabase
            .from("partners")
            .select("user_id, verified_at, contact_email, display_name")
            .eq("id", partnerId)
            .maybeSingle();
        if (!pRow) {
            console.warn(`Settlement: partner ${partnerId} not found`);
            continue;
        }
        if (!pRow.verified_at) {
            blockedUnverified.push({
                partner_id: partnerId,
                reason: `Partner ${pRow.display_name || partnerId} is not yet verified — commission held until admin approves verification in admin-verifications.html`,
            });
            // Skip this partner — their commissions stay unsettled (no settlement_id),
            // so the next settlement run picks them up automatically once verified.
            continue;
        }

        // Create the settlement row
        const { data: settlement, error: sErr } = await supabase
            .from("settlements")
            .insert({
                partner_id: partnerId,
                period_start: body.period_start,
                period_end: body.period_end,
                total_amount: bucket.amount,
                status: "pending",
            })
            .select("id")
            .single();

        if (sErr || !settlement) {
            console.error(`Settlement insert failed for partner ${partnerId}:`, sErr);
            continue; // skip this partner; others can still settle
        }

        // Link the commissions to this settlement
        const { error: lErr } = await supabase
            .from("partner_commissions")
            .update({ settlement_id: settlement.id })
            .in("id", bucket.ids);

        if (lErr) {
            console.error(`Commission linking failed for settlement ${settlement.id}:`, lErr);
            // The settlement exists with the right total but commissions are unlinked.
            // A reconciliation script can fix this; flag it in the response.
        }

        results.push({
            partner_id: partnerId,
            settlement_id: settlement.id,
            amount: Number(bucket.amount.toFixed(2)),
            commission_count: bucket.count,
        });
    }

    const totalAmount = results.reduce((s, x) => s + x.amount, 0);

    return jsonResponse({
        settlements_created: results.length,
        total_amount: Number(totalAmount.toFixed(2)),
        settlements: results,
        blocked_unverified: blockedUnverified,
        blocked_count: blockedUnverified.length,
        dry_run: false,
    });
});
