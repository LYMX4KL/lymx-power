// =============================================================================
// LYMX Power — Partner daily income digest
// =============================================================================
// GET/POST /functions/v1/partner-daily-income
//
// Hit once daily by pg_cron (migration 144). For every active partner with
// commission activity, sends:
//   • an in-app notification (kind 'daily_income') via fn_emit_partner_notification
//   • an email summary via Resend
// covering YESTERDAY's earnings + MONTH-TO-DATE, with cash and LYMX kept in their
// own units (never summed together). Idempotent per partner per day via
// partner_income_digest_log. Reads the authoritative partner_commissions ledger.
//
// verify_jwt disabled — public cron target (protected by the service-role call).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const TZ = "America/Los_Angeles";
function ymd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
const usd = (n: number) => "$" + (n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lymx = (n: number) => Math.round(n || 0).toLocaleString("en-US") + " LYMX";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const SB_URL = Deno.env.get("SUPABASE_URL")!;
    const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
    if (!SB_URL || !SB_KEY) return json({ ok: false, error: "missing env" }, 500);
    const sb = createClient(SB_URL, SB_KEY);

    const url = new URL(req.url);
    const dry = url.searchParams.get("dry") === "1";

    const today = ymd(new Date());
    const yest = ymd(new Date(Date.now() - 86400000));
    // Month start (local) as an ISO instant we can compare created_at against.
    const monthStartLocal = today.slice(0, 8) + "01";
    const monthStartISO = new Date(monthStartLocal + "T00:00:00").toISOString();

    // Pull this-month commissions once; bucket per partner.
    const { data: comms, error: cErr } = await sb
      .from("partner_commissions")
      .select("partner_id, amount, payout_kind, source_kind, settlement_id, created_at")
      .gte("created_at", monthStartISO)
      .limit(50000);
    if (cErr) return json({ ok: false, error: cErr.message }, 500);

    type Agg = { yCash: number; yLymx: number; mCash: number; mLymx: number; mPend: number };
    const agg: Record<string, Agg> = {};
    for (const c of comms || []) {
      const k = c.partner_id as string;
      if (!agg[k]) agg[k] = { yCash: 0, yLymx: 0, mCash: 0, mLymx: 0, mPend: 0 };
      const isL = c.payout_kind === "lymx";
      const amt = Number(c.amount || 0);
      const day = ymd(new Date(c.created_at as string));
      if (isL) { agg[k].mLymx += amt; if (day === yest) agg[k].yLymx += amt; }
      else {
        agg[k].mCash += amt; if (!c.settlement_id) agg[k].mPend += amt;
        if (day === yest) agg[k].yCash += amt;
      }
    }

    const ids = Object.keys(agg);
    if (!ids.length) return json({ ok: true, sent: 0, note: "no commission activity this month" });

    const { data: partners } = await sb
      .from("partners")
      .select("id, display_name, legal_name, contact_email, archived_at")
      .in("id", ids);

    const { data: already } = await sb
      .from("partner_income_digest_log")
      .select("partner_id")
      .eq("digest_date", today);
    const sentSet = new Set((already || []).map((r: any) => r.partner_id));

    // saved monthly cash goals (for the progress reminder)
    const { data: goalsRows } = await sb
      .from("partner_goals").select("partner_id, monthly_cash_goal").in("partner_id", ids);
    const goalMap: Record<string, number> = {};
    (goalsRows || []).forEach((g: any) => { goalMap[g.partner_id] = Number(g.monthly_cash_goal || 0); });

    const results: any[] = [];
    for (const p of partners || []) {
      if (p.archived_at) continue;
      if (sentSet.has(p.id)) { results.push({ partner: p.id, skipped: "already sent today" }); continue; }
      const a = agg[p.id];
      if (!a) continue;
      // Only message partners with something to report (avoid empty-digest spam).
      if (a.yCash === 0 && a.yLymx === 0 && a.mCash === 0 && a.mLymx === 0) continue;

      const name = (p.display_name || (p.legal_name || "Partner").split(" ")[0]);
      const yParts = [a.yCash ? usd(a.yCash) : "", a.yLymx ? lymx(a.yLymx) : ""].filter(Boolean).join(" + ") || "$0.00";
      const mParts = [a.mCash ? usd(a.mCash) : "", a.mLymx ? lymx(a.mLymx) : ""].filter(Boolean).join(" + ") || "$0.00";
      const goal = goalMap[p.id] || 0;
      let goalLine = "";
      if (goal > 0) {
        const pct = Math.min(100, Math.round(a.mCash / goal * 100));
        goalLine = a.mCash >= goal
          ? ` \uD83C\uDF89 You hit your ${usd(goal)}/mo goal!`
          : ` \uD83C\uDFAF ${pct}% to your ${usd(goal)}/mo goal — ${usd(goal - a.mCash)} to go.`;
      }
      const title = `Your income yesterday: ${yParts}`;
      const body = `Month-to-date: ${mParts}` + (a.mPend ? ` · ${usd(a.mPend)} pending payout.` : ".") + goalLine;

      if (!dry) {
        // In-app notification (service-role context: fn_emit allows it)
        const { error: nErr } = await sb.rpc("fn_emit_partner_notification", {
          p_partner_id: p.id, p_kind: "daily_income", p_title: title, p_body: body,
          p_target_url: "/income-statement.html", p_related_entity_type: "daily_income", p_related_entity_id: null,
        });
        if (nErr) results.push({ partner: p.id, notify_error: nErr.message });

        // Email (best-effort)
        let emailed = false;
        if (RESEND_KEY && p.contact_email) {
          const html = `<div style="font-family:-apple-system,Segoe UI,Inter,sans-serif;font-size:15px;color:#0e1116;line-height:1.55">
            <p>Hi ${name},</p>
            <p style="font-size:22px;font-weight:800;margin:8px 0">${yParts}</p>
            <p style="color:#5b6472;margin:0 0 14px">earned yesterday (${yest}).</p>
            <p>Month-to-date: <strong>${mParts}</strong>${a.mPend ? ` · <strong>${usd(a.mPend)}</strong> pending in your next payout` : ""}.</p>
            <p style="margin-top:18px"><a href="https://getlymx.com/income-statement.html" style="display:inline-block;background:#0a84ff;color:#fff;padding:11px 22px;border-radius:9px;font-weight:700;text-decoration:none">📑 View my statement</a></p>
            <hr style="border:0;border-top:1px solid #e6e8ec;margin:22px 0 12px" />
            <div style="font-size:12px;color:#5b6472">Cash and LYMX rewards are shown separately. LYMX is spendable across the LYMX network.</div>
          </div>`;
          const text = `Hi ${name}\nEarned yesterday: ${yParts}\nMonth-to-date: ${mParts}${a.mPend ? ` (${usd(a.mPend)} pending)` : ""}\nStatement: https://getlymx.com/income-statement.html`;
          try {
            const r = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({ from: "LYMX <noreply@getlymx.com>", to: [p.contact_email], subject: title, html, text }),
            });
            emailed = r.ok;
          } catch (_) { emailed = false; }
        }

        await sb.from("partner_income_digest_log").insert({ partner_id: p.id, digest_date: today });
        results.push({ partner: p.id, sent: true, emailed, yesterday: yParts, mtd: mParts });
      } else {
        results.push({ partner: p.id, would_send: true, yesterday: yParts, mtd: mParts });
      }
    }

    return json({ ok: true, date: today, processed: results.length, results });
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
});
