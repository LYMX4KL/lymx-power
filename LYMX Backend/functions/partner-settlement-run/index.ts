// =============================================================================
// LYMX Power — Partner Settlement Run
// =============================================================================
// POST /functions/v1/partner-settlement-run
//
// Batches all unsettled (`settlement_id IS NULL`) commissions for one partner
// (or all partners) into a `settlements` row marked status='pending'.
// Admin can then mark the settlement paid (via SQL or a future Pay UI) which
// is what flips Helen's dashboard from "pending" to "paid".
//
// REQUEST BODY:
//   { "partner_id": "uuid" | null,   // null = run for ALL partners
//     "period_end": "2026-05-20" | null  // null = today
//   }
//
// RESPONSE (200):
//   { "ok": true, "runs": [
//       { partner_id, settlement_id, total_amount, commission_count }, ...
//     ], "skipped": [...]
//   }
//
// AUTH: caller must be admin (hardcoded UUID OR staff_roles.role='admin').
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// Admin is resolved via staff_roles (role='admin'); no hardcoded UUID bypass.

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const err = (m: string, s = 400) => json({ error: m }, s);

function userFromJwt(authHeader: string | null): string | null {
    if (!authHeader) return null;
    const tok = authHeader.replace(/^Bearer\s+/i, "").trim();
    const parts = tok.split(".");
    if (parts.length !== 3) return null;
    try {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        return payload.sub || null;
    } catch { return null; }
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST")    return err("Method not allowed", 405);

    const userId = userFromJwt(req.headers.get("Authorization"));
    if (!userId) return err("Sign in required.", 401);

    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Admin gate
    {
        const { data: staff } = await supabase.from("staff_roles")
            .select("role").eq("user_id", userId).maybeSingle();
        if (!staff || !["admin", "accounting"].includes(staff.role)) {
            return err("Admin only.", 403);
        }
    }

    let body: { partner_id?: string; period_end?: string };
    try { body = await req.json(); } catch { body = {}; }
    const periodEnd = body.period_end || new Date().toISOString().slice(0, 10);

    // Find partners with unsettled commissions
    let partnerIds: string[] = [];
    if (body.partner_id) {
        partnerIds = [body.partner_id];
    } else {
        const { data: distinctRows } = await supabase
            .from("partner_commissions")
            .select("partner_id")
            .is("settlement_id", null);
        const set = new Set<string>();
        (distinctRows || []).forEach((r: any) => { if (r.partner_id) set.add(r.partner_id); });
        partnerIds = Array.from(set);
    }

    const runs: Array<{ partner_id: string; settlement_id: string; total_amount: number; commission_count: number }> = [];
    const skipped: Array<{ partner_id: string; reason: string }> = [];

    for (const partnerId of partnerIds) {
        // Load all unsettled commissions for this partner
        const { data: comms, error: commErr } = await supabase
            .from("partner_commissions")
            .select("id, amount, created_at")
            .eq("partner_id", partnerId)
            .is("settlement_id", null);
        if (commErr) { skipped.push({ partner_id: partnerId, reason: "commission read: " + commErr.message }); continue; }
        if (!comms || comms.length === 0) { skipped.push({ partner_id: partnerId, reason: "no unsettled commissions" }); continue; }

        const totalAmount = comms.reduce((s, c: any) => s + Number(c.amount || 0), 0);
        if (totalAmount <= 0) { skipped.push({ partner_id: partnerId, reason: "total amount <= 0" }); continue; }

        const earliest = comms.reduce((min: string, c: any) =>
            (!min || c.created_at < min) ? c.created_at : min,
            comms[0].created_at as string,
        );
        const periodStart = (earliest || new Date().toISOString()).slice(0, 10);

        // Create the settlements row
        const { data: settlement, error: sErr } = await supabase
            .from("settlements")
            .insert({
                partner_id: partnerId,
                period_start: periodStart,
                period_end: periodEnd,
                total_amount: totalAmount,
                status: "pending",
            })
            .select("id")
            .single();
        if (sErr || !settlement) { skipped.push({ partner_id: partnerId, reason: "settlement insert: " + (sErr?.message || "unknown") }); continue; }

        // Link all the commissions to this settlement
        const commIds = comms.map((c: any) => c.id);
        const { error: linkErr } = await supabase
            .from("partner_commissions")
            .update({ settlement_id: settlement.id })
            .in("id", commIds);
        if (linkErr) {
            // Best-effort: leave the settlement row (admin can re-link), but report
            skipped.push({ partner_id: partnerId, reason: "link update: " + linkErr.message });
            continue;
        }

        // Notify the partner via email
        try {
            const { data: partner } = await supabase
                .from("partners")
                .select("legal_name, display_name, contact_email")
                .eq("id", partnerId).maybeSingle();
            if (partner && partner.contact_email) {
                const firstName = (partner.display_name || partner.legal_name || "Partner").split(/\s+/)[0];
                const fmtUsd = "$" + totalAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const subj = `Your LYMX payout is queued — ${fmtUsd}`;
                const bodyText = `Hi ${firstName},

Your commissions for the period ${periodStart} through ${periodEnd} have been bundled into a payout of ${fmtUsd}, covering ${comms.length} commission${comms.length === 1 ? "" : "s"}.

Status: pending — admin reviews payouts before sending. You'll get a second email when payment is on its way to your account.

You can see the breakdown anytime on your Payouts page:
https://getlymx.com/partner-payouts.html

— The LYMX team`;
                await fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/send-email", {
                    method: "POST",
                    headers: {
                        "Authorization": "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        recipient_email: partner.contact_email,
                        subject: subj,
                        body_text: bodyText,
                        kind: "partner_settlement_queued",
                        channel: "transactional",
                    }),
                });
            }
        } catch (notifyErr) {
            console.warn("Settlement notification failed (non-fatal):", (notifyErr as Error).message);
        }

        runs.push({
            partner_id: partnerId,
            settlement_id: settlement.id,
            total_amount: totalAmount,
            commission_count: comms.length,
        });
    }

    return json({
        ok: true,
        runs,
        skipped,
        period_end: periodEnd,
        total_partners_processed: runs.length,
        total_amount_queued: runs.reduce((s, r) => s + r.total_amount, 0),
    });
});
