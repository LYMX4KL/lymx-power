// supabase/functions/fraud-scan/index.ts
// Runs daily (via pg_cron). Detects velocity/pattern anomalies and writes
// fraud_flags rows so admin reviews them on /admin-fraud-flags.html.
//
// Patterns detected:
//
//   1. BURST_ISSUANCE — a business issued an unusually large amount of LYMX
//      in a 24h window relative to its 30-day baseline. Possible fake-tx farming.
//
//   2. ARBITRAGE_LOOP — a customer redeemed LYMX at Business B that was issued
//      to them by Business A, where the customer's auth user is also the owner
//      of Business A (within 14 days of the issuance). The classic 20% arb.
//
//   3. CONCENTRATION — a business issued LYMX where >50% of issuances in the
//      last 7 days went to a single recipient (likely insider).
//
//   4. STALE_OPEN_FLAGS — escalate any 'open' fraud flag still open after 7d.
//
// Per Kenny's spec 2026-05-18.

import { serve } from 'https://deno.land/std@0.182.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405 });
  }
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  const report = { flags_written: 0, burst_count: 0, arb_count: 0, conc_count: 0, escalated_count: 0 };

  try {
    const now = Date.now();
    const day1 = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
    const day7 = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const day14 = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();
    const day30 = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    // -------- 1. BURST_ISSUANCE: today vs 30d baseline --------
    // Pull last 30 days of issuances grouped by business + by day.
    const { data: iss30 } = await sb.from('lymx_issuances')
      .select('source_business_id, amount_lymx, created_at')
      .gte('created_at', day30)
      .not('source_business_id', 'is', null);
    if (iss30 && iss30.length) {
      // Sum per (business, day) and compute mean for baseline (excluding today)
      const totalsByBiz: Record<string, number[]> = {};
      const todayIso = new Date(now).toISOString().slice(0, 10);
      iss30.forEach((r: any) => {
        const day = (r.created_at || '').slice(0, 10);
        if (!totalsByBiz[r.source_business_id]) totalsByBiz[r.source_business_id] = Array(30).fill(0);
        const daysAgo = Math.floor((Date.now() - new Date(day).getTime()) / 86400000);
        if (daysAgo >= 0 && daysAgo < 30) totalsByBiz[r.source_business_id][daysAgo] += Number(r.amount_lymx || 0);
      });

      for (const [bizId, daily] of Object.entries(totalsByBiz)) {
        const today = daily[0];
        if (today < 5000) continue; // ignore small-volume businesses
        const baseline = daily.slice(1).reduce((s, n) => s + n, 0) / 29;
        if (baseline < 100) continue; // no real baseline yet
        if (today > baseline * 5) {
          // 5x spike: write a high-severity flag
          // Dedupe: check if a burst flag for this biz already exists in last 24h
          const { count } = await sb.from('fraud_flags').select('id', { count: 'exact', head: true })
            .eq('flag_type', 'burst_issuance').eq('business_id', bizId).gte('created_at', day1);
          if ((count || 0) > 0) continue;
          await sb.from('fraud_flags').insert({
            flag_type: 'burst_issuance', severity: 'high', status: 'open',
            subject_kind: 'business', subject_id: bizId,
            business_id: bizId,
            amount_lymx: today,
            summary: `Business issued ${Math.round(today).toLocaleString()} LYMX today vs ${Math.round(baseline).toLocaleString()} avg/day over the last 29 days (${(today / baseline).toFixed(1)}× spike). Possible fake-transaction farming.`,
            detection_data: {
              today_lymx: today,
              baseline_daily_mean: baseline,
              ratio: today / baseline,
              window: '24h vs 29d'
            }
          });
          report.flags_written++;
          report.burst_count++;
        }
      }
    }

    // -------- 2. ARBITRAGE_LOOP: customer = business owner → cross-biz redemption --------
    // For each redemption in last 7 days, check if the redeeming customer is
    // also the owner of a different business that issued LYMX to them recently.
    const { data: redemptions } = await sb.from('transactions')
      .select('id, customer_id, business_id, lymx_amount, created_at')
      .eq('type', 'redemption')
      .gte('created_at', day7);
    if (redemptions && redemptions.length) {
      // Pull all business owners to build a fast lookup: user_id -> [business_ids]
      const { data: bizOwners } = await sb.from('businesses')
        .select('id, owner_user_id').is('archived_at', null).not('owner_user_id', 'is', null);
      const ownerToBiz: Record<string, string[]> = {};
      (bizOwners || []).forEach((b: any) => {
        if (!ownerToBiz[b.owner_user_id]) ownerToBiz[b.owner_user_id] = [];
        ownerToBiz[b.owner_user_id].push(b.id);
      });

      for (const r of redemptions) {
        // Find customer's user_id from customers table
        const { data: cust } = await sb.from('customers').select('user_id').eq('id', r.customer_id).limit(1).maybeSingle();
        if (!cust || !cust.user_id) continue;
        const ownedBizs = ownerToBiz[cust.user_id];
        if (!ownedBizs || !ownedBizs.length) continue;
        // Customer is a biz owner. Was redemption at a DIFFERENT business than what they own?
        if (ownedBizs.includes(r.business_id)) continue; // redeeming at their own biz — not arb
        // Check if LYMX issued to them by one of their own businesses recently
        const { count } = await sb.from('lymx_issuances').select('id', { count: 'exact', head: true })
          .eq('recipient_user_id', cust.user_id)
          .in('source_business_id', ownedBizs)
          .gte('created_at', day14);
        if (!count) continue;
        // Dedupe: existing arb flag for this transaction?
        const { count: dupCount } = await sb.from('fraud_flags').select('id', { count: 'exact', head: true })
          .eq('flag_type', 'arbitrage_loop').eq('subject_id', r.id);
        if ((dupCount || 0) > 0) continue;
        await sb.from('fraud_flags').insert({
          flag_type: 'arbitrage_loop', severity: 'critical', status: 'open',
          subject_kind: 'transaction', subject_id: r.id,
          business_id: r.business_id,
          user_id: cust.user_id,
          amount_lymx: Math.abs(Number(r.lymx_amount || 0)),
          summary: `Customer who owns ${ownedBizs.length} business(es) redeemed ${Math.round(Math.abs(r.lymx_amount)).toLocaleString()} LYMX at a different business after receiving issuance from their own business within 14 days. 20% arbitrage pattern.`,
          detection_data: {
            transaction_id: r.id,
            redeem_business_id: r.business_id,
            customer_user_id: cust.user_id,
            customer_owned_businesses: ownedBizs,
            recent_issuance_count: count,
            window: '14d issuance / 7d redemption'
          }
        });
        report.flags_written++;
        report.arb_count++;
      }
    }

    // -------- 3. CONCENTRATION: single recipient > 50% of biz issuance in 7d --------
    const { data: iss7 } = await sb.from('lymx_issuances')
      .select('source_business_id, recipient_user_id, amount_lymx')
      .gte('created_at', day7)
      .not('source_business_id', 'is', null);
    if (iss7 && iss7.length) {
      const byBiz: Record<string, { total: number; byRecip: Record<string, number> }> = {};
      iss7.forEach((r: any) => {
        if (!byBiz[r.source_business_id]) byBiz[r.source_business_id] = { total: 0, byRecip: {} };
        const amt = Number(r.amount_lymx || 0);
        byBiz[r.source_business_id].total += amt;
        if (r.recipient_user_id) {
          byBiz[r.source_business_id].byRecip[r.recipient_user_id] = (byBiz[r.source_business_id].byRecip[r.recipient_user_id] || 0) + amt;
        }
      });
      for (const [bizId, info] of Object.entries(byBiz)) {
        if (info.total < 3000) continue; // ignore small
        const top = Object.entries(info.byRecip).sort((a, b) => b[1] - a[1])[0];
        if (!top) continue;
        const [topUid, topAmt] = top as [string, number];
        const pct = topAmt / info.total;
        if (pct < 0.5) continue;
        // Dedupe — one concentration flag per biz per 7d window
        const { count } = await sb.from('fraud_flags').select('id', { count: 'exact', head: true })
          .eq('flag_type', 'concentration').eq('business_id', bizId).gte('created_at', day7);
        if ((count || 0) > 0) continue;
        await sb.from('fraud_flags').insert({
          flag_type: 'concentration', severity: 'medium', status: 'open',
          subject_kind: 'business', subject_id: bizId,
          business_id: bizId,
          user_id: topUid,
          amount_lymx: topAmt,
          summary: `One recipient received ${Math.round(pct * 100)}% (${Math.round(topAmt).toLocaleString()} LYMX) of this business's total 7-day issuance. Likely insider account.`,
          detection_data: {
            business_id: bizId,
            top_recipient: topUid,
            top_recipient_amount: topAmt,
            biz_total_7d: info.total,
            concentration_pct: pct
          }
        });
        report.flags_written++;
        report.conc_count++;
      }
    }

    // -------- 4. STALE_OPEN_FLAGS: any open flag still open after 7d → bump severity --------
    const { data: stale } = await sb.from('fraud_flags')
      .select('id, severity, summary')
      .eq('status', 'open').lt('created_at', day7);
    if (stale && stale.length) {
      for (const f of stale) {
        if (f.severity === 'critical') continue;
        const bump: Record<string, string> = { low: 'medium', medium: 'high', high: 'critical' };
        const newSev = bump[f.severity] || 'critical';
        await sb.from('fraud_flags').update({
          severity: newSev,
          summary: (f.summary || '') + ' [auto-escalated after 7d unreviewed]'
        }).eq('id', f.id);
        report.escalated_count++;
      }
    }

    return new Response(JSON.stringify({ ok: true, report }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  } catch (e) {
    console.error('[fraud-scan] error', e);
    return new Response(JSON.stringify({ ok: false, error: String(e), report }), {
      status: 500, headers: { 'content-type': 'application/json' }
    });
  }
});
