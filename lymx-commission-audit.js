/* lymx-commission-audit.js — Admin/accounting reconciliation layer.
 * Injects an "Actual ledger & audit" panel at the top of commission-backend.html.
 * Reads the AUTHORITATIVE engine ledger (partner_commissions, admin-readable via
 * migration 142) — this is the source of truth, distinct from the modeled
 * estimator already on the page. Surfaces discrepancies for Helen/accounting:
 *   - Activated businesses missing an activation-bonus accrual
 *   - Activation rows pointing at a missing business (orphan)
 *   - Commission rows for an unknown/archived partner
 * Admin-only (page is data-role-required="admin"). Built 2026-05-30.
 */
(function () {
  if (window.__lymxCommAudit) return;
  window.__lymxCommAudit = true;

  var usd = function (n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var lymx = function (n) { return Math.round(Number(n || 0)).toLocaleString('en-US') + ' LYMX'; };

  async function run() {
    try {
      if (!window.LYMX || !window.LYMX.getSession) return;
      var sess = await window.LYMX.getSession(); if (!sess) return;
      var sb = window.LYMX.sb;

      var pRes = await sb.from('partners').select('id, display_name, legal_name').limit(2000);
      var cRes = await sb.from('partner_commissions')
        .select('partner_id, amount, payout_kind, source_kind, generation, settlement_id, source_business_id, created_at').limit(10000);
      var bRes = await sb.from('businesses')
        .select('id, display_name, legal_name, signed_up_by_partner_id, signup_paid_at, created_at').is('archived_at', null).limit(5000);

      var comms = cRes.data || [];
      // mig 142 admin read policy gates this. If it returned nothing but rows exist,
      // the policy likely isn't applied yet — say so rather than imply "no data".
      if (cRes.error) { console.warn('[audit] commissions read error', cRes.error); }

      var partners = {}; (pRes.data || []).forEach(function (p) { partners[p.id] = p; });
      var bizById = {}; (bRes.data || []).forEach(function (b) { bizById[b.id] = b; });

      // Per-partner real totals
      var per = {};
      var totCash = 0, totLymx = 0, totPendCash = 0;
      comms.forEach(function (c) {
        var k = c.partner_id;
        if (!per[k]) per[k] = { cash: 0, lymx: 0, pend: 0, rows: 0 };
        per[k].rows++;
        if (c.payout_kind === 'lymx') { per[k].lymx += +c.amount || 0; totLymx += +c.amount || 0; }
        else {
          per[k].cash += +c.amount || 0; totCash += +c.amount || 0;
          if (!c.settlement_id) { per[k].pend += +c.amount || 0; totPendCash += +c.amount || 0; }
        }
      });

      // Discrepancy checks
      var issues = [];
      var actByBiz = {};
      comms.forEach(function (c) { if (c.source_kind === 'activation' && c.source_business_id) actByBiz[c.source_business_id] = true; });
      (bRes.data || []).forEach(function (b) {
        if (b.signed_up_by_partner_id && b.signup_paid_at && !actByBiz[b.id])
          issues.push({ sev: 'warn', msg: 'Activated business "' + (b.display_name || b.legal_name || b.id) + '" has no activation-bonus row — accrual may be missing (run backfill_activation_bonuses).' });
      });
      comms.forEach(function (c) {
        if (c.source_kind === 'activation' && c.source_business_id && !bizById[c.source_business_id])
          issues.push({ sev: 'warn', msg: 'Activation commission references missing/archived business ' + c.source_business_id + '.' });
        if (!partners[c.partner_id])
          issues.push({ sev: 'err', msg: 'Commission row for unknown/archived partner ' + c.partner_id + '.' });
      });
      // de-dup
      var seen = {}; issues = issues.filter(function (i) { var key = i.sev + i.msg; if (seen[key]) return false; seen[key] = 1; return true; });

      // Build panel
      var rowsHtml = Object.keys(per).map(function (k) {
        var p = partners[k]; var nm = p ? (p.display_name || p.legal_name || k) : ('⚠ unknown (' + String(k).slice(0, 8) + ')');
        var v = per[k];
        return '<tr><td>' + nm + '</td><td class="num">' + usd(v.cash) + '</td><td class="num">' + (v.lymx ? lymx(v.lymx) : '—') + '</td><td class="num">' + usd(v.pend) + '</td><td class="num">' + v.rows + '</td></tr>';
      }).sort().join('') || '<tr><td colspan="5" style="padding:18px;color:#5b6472">No commission rows visible. If the engine has run, confirm migration 142 (admin read policy) is applied.</td></tr>';

      var issuesHtml = issues.length
        ? issues.map(function (i) { return '<li style="margin:4px 0;color:' + (i.sev === 'err' ? '#e0413e' : '#9a6500') + '">' + (i.sev === 'err' ? '⛔ ' : '⚠️ ') + i.msg + '</li>'; }).join('')
        : '<li style="color:#13a26b">✅ No discrepancies found — ledger reconciles.</li>';

      var panel = document.createElement('div');
      panel.style.cssText = 'background:#fff;border:1px solid #e6e8ec;border-radius:14px;padding:20px 22px;box-shadow:0 10px 30px rgba(14,17,22,.08);margin:16px 0';
      panel.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;margin-bottom:6px">' +
          '<h2 style="margin:0;font-size:18px">Actual ledger &amp; audit <span style="font-size:12px;font-weight:700;color:#13a26b;background:rgba(19,162,107,.12);padding:2px 8px;border-radius:6px;margin-left:6px">SOURCE OF TRUTH</span></h2>' +
          '<span style="font-size:12.5px;color:#5b6472">Reads the engine ledger directly. The table below this is a modeled estimate.</span>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:14px 0">' +
          '<div style="background:#f6f7f9;border-radius:10px;padding:12px 14px"><div style="font-size:11px;text-transform:uppercase;color:#5b6472;font-weight:700">Cash accrued</div><div style="font-size:22px;font-weight:800">' + usd(totCash) + '</div></div>' +
          '<div style="background:#f6f7f9;border-radius:10px;padding:12px 14px"><div style="font-size:11px;text-transform:uppercase;color:#5b6472;font-weight:700">LYMX rewards</div><div style="font-size:22px;font-weight:800">' + lymx(totLymx) + '</div></div>' +
          '<div style="background:#f6f7f9;border-radius:10px;padding:12px 14px"><div style="font-size:11px;text-transform:uppercase;color:#5b6472;font-weight:700">Cash pending payout</div><div style="font-size:22px;font-weight:800">' + usd(totPendCash) + '</div></div>' +
          '<div style="background:#f6f7f9;border-radius:10px;padding:12px 14px"><div style="font-size:11px;text-transform:uppercase;color:#5b6472;font-weight:700">Commission rows</div><div style="font-size:22px;font-weight:800">' + comms.length + '</div></div>' +
        '</div>' +
        '<div style="overflow:auto;border:1px solid #e6e8ec;border-radius:10px;margin-bottom:14px"><table style="width:100%;border-collapse:collapse;font-size:13.5px">' +
          '<thead><tr style="background:#f6f7f9"><th style="text-align:left;padding:9px 12px">Partner</th><th style="text-align:right;padding:9px 12px">Cash</th><th style="text-align:right;padding:9px 12px">LYMX</th><th style="text-align:right;padding:9px 12px">Pending</th><th style="text-align:right;padding:9px 12px">Rows</th></tr></thead>' +
          '<tbody>' + rowsHtml + '</tbody></table></div>' +
        '<div><div style="font-weight:700;margin-bottom:4px">Discrepancy audit</div><ul style="margin:0;padding-left:18px;font-size:13.5px">' + issuesHtml + '</ul></div>';

      var host = document.querySelector('main') || document.querySelector('.wrap') || document.body;
      host.insertBefore(panel, host.firstElementChild);
      // tabular-nums for the .num cells
      panel.querySelectorAll('.num').forEach(function (td) { td.style.cssText = 'text-align:right;padding:8px 12px;font-variant-numeric:tabular-nums;border-top:1px solid #f0f1f3'; });
    } catch (e) { console.warn('[lymx-commission-audit] failed', e); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(run, 500); });
  else setTimeout(run, 500);
})();
