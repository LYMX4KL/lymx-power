// =============================================================================
// LYMX Power — Public Stats Aggregator
// =============================================================================
// GET /functions/v1/public-stats
//
// Returns aggregate network statistics suitable for the public /stats page.
// Tables are RLS-locked from anon reads (correct — we don't want anon clients
// scraping row data). This EF runs with service_role internally to compute
// aggregate counts + sums, returning only opaque numbers. Zero PII.
//
// Response cached for 60 seconds (matches the page's refresh interval).
//
// RESPONSE (200):
//   {
//     customers_total, customers_this_week,
//     businesses_total, partners_total,
//     issued_lifetime, issued_this_week,
//     in_circulation, in_circulation_usd_cents,
//     redeemed_today_lymx, redeemed_today_usd, redeemed_today_count,
//     reviews_verified, feedback_total,
//     issued_by_category_7d: [{category, total_lymx}, ...]
//   }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(SUPABASE_URL, SVC_KEY);

    const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const todayStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); })();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    try {
        // 2026-05-20 audit fix - "in_circulation" was incorrectly reading wallets.balance, but per migration 013 the SOURCE OF TRUTH for LYMX balance is the lymx_issuances ledger (the wallets table is only for per-business post-transaction balances, not signup/referral bonuses). Now: in_circulation = lifetime issued (auto/approved only) - lifetime redeemed. Pre-launch this is honest and goes to zero only when LYMX is fully spent.
        const [
            custTotal, custWeek, bizTotal, partnersTotal,
            issAuto, issWeek, txAllRedemptions, txToday,
            reviewsVerified, feedbackTotal,
            issByCategoryRaw, bizByCategoryRaw
        ] = await Promise.all([
            sb.from("customers").select("id", { count: "exact", head: true }),
            sb.from("customers").select("id", { count: "exact", head: true }).gte("created_at", weekStart),
            sb.from("businesses").select("id", { count: "exact", head: true }),
            sb.from("partners").select("id", { count: "exact", head: true }),
            sb.from("lymx_issuances").select("amount_lymx").in("admin_status", ["auto", "approved"]).limit(50000),
            sb.from("lymx_issuances").select("amount_lymx").in("admin_status", ["auto", "approved"]).gte("created_at", weekStart).limit(50000),
            sb.from("transactions").select("lymx_amount").eq("type", "redemption").limit(50000),
            sb.from("transactions").select("lymx_amount, usd_basis").eq("type", "redemption").gte("created_at", todayStart).limit(50000),
            sb.from("reviews").select("id", { count: "exact", head: true }).not("verified_at", "is", null),
            sb.from("feedback").select("id", { count: "exact", head: true }),
            sb.from("lymx_issuances").select("amount_lymx, business_id, businesses(category)").gte("created_at", sevenDaysAgo).limit(50000),
            sb.from("businesses").select("id, category, display_name")
        ]);

        const issuedLifetime  = (issAuto.data || []).reduce((s, r) => s + Number(r.amount_lymx || 0), 0);
        const issuedWeek      = (issWeek.data || []).reduce((s, r) => s + Number(r.amount_lymx || 0), 0);
        const redeemedLifetime = (txAllRedemptions.data || []).reduce((s, t) => s + Math.abs(Number(t.lymx_amount || 0)), 0);
        const inCirculation   = Math.max(0, issuedLifetime - redeemedLifetime);
        const todayLymx       = (txToday.data || []).reduce((s, t) => s + Math.abs(Number(t.lymx_amount || 0)), 0);
        const todayUsd        = (txToday.data || []).reduce((s, t) => s + Math.abs(Number(t.usd_basis || 0)), 0);

        // 7-day issuance breakdown by category
        const byCategory: Record<string, number> = {};
        (issByCategoryRaw.data || []).forEach((r: any) => {
            const cat = (r.businesses && r.businesses.category) || "Uncategorized";
            byCategory[cat] = (byCategory[cat] || 0) + Number(r.amount_lymx || 0);
        });
        const issued_by_category_7d = Object.entries(byCategory)
            .sort((a, b) => Number(b[1]) - Number(a[1]))
            .map(([category, total_lymx]) => ({ category, total_lymx }));

        // Coverage-map - businesses grouped by category
        const businessesByCategory: Record<string, number> = {};
        (bizByCategoryRaw.data || []).forEach((b: any) => {
            const cat = String(b.category || "Uncategorized").toLowerCase();
            businessesByCategory[cat] = (businessesByCategory[cat] || 0) + 1;
        });

        // Launch 25 progress
        const launch25Cap = 25;
        const launch25SpotsOpen = Math.max(0, launch25Cap - (bizTotal.count || 0));

        const payload = {
            customers_total: custTotal.count || 0,
            customers_this_week: custWeek.count || 0,
            businesses_total: bizTotal.count || 0,
            launch25_spots_open: launch25SpotsOpen,
            partners_total: partnersTotal.count || 0,
            issued_lifetime: issuedLifetime,
            issued_this_week: issuedWeek,
            redeemed_lifetime: redeemedLifetime,
            in_circulation: inCirculation,
            in_circulation_usd_cents: inCirculation, // 1 LYMX = $0.01 so cents == LYMX
            redeemed_today_lymx: todayLymx,
            redeemed_today_usd: todayUsd,
            redeemed_today_count: (txToday.data || []).length,
            reviews_verified: reviewsVerified.count || 0,
            feedback_total: feedbackTotal.count || 0,
            issued_by_category_7d,
            businesses_by_category: businessesByCategory,
            businesses_list: (bizByCategoryRaw.data || []).map((b: any) => ({ id: b.id, category: b.category, display_name: b.display_name })),
            generated_at: new Date().toISOString(),
        };

        return new Response(JSON.stringify(payload), {
            status: 200,
            headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
                // Cache for 60 seconds in CDN/browser - matches page refresh cadence
                "Cache-Control": "public, max-age=60, s-maxage=60",
            },
        });
    } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        return new Response(JSON.stringify({ error: err }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});
