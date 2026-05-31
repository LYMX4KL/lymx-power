/* lymx-comp-config.js — single source of truth for comp-plan numbers.
 * Fetches the current commission_rate_config via the public RPC
 * current_commission_config() (anon-readable, migration 147) and:
 *   1. exposes it as window.LYMXComp.cfg (+ window.LYMXComp.ready promise)
 *   2. auto-fills any element with data-comp="<key>:<fmt>" with the live value
 * Formats: usd (cents->$X,XXX), usd2 (cents->$X.XX), pct (number->X%), int, raw.
 * Falls back to the shipped defaults so pages still render if the fetch fails.
 * Built 2026-05-30 to kill the $500/9% vs $750/11% drift across comp pages.
 */
(function () {
  if (window.LYMXComp) return;
  var DEFAULTS = {
    activation_bonus_regular_cents: 50000,
    activation_bonus_founding_cents: 75000,
    founding_speed_bonus_cents: 100000,
    founding_speed_count: 5,
    founding_speed_window_months: 3,
    transaction_fee_pct: 3,
    direct_pct_regular: 9,
    direct_pct_founding: 11,
    g1_pct: 3, g2_pct: 2, g3_pct: 1,
    monthly_fee_free_months: 3
  };
  var LYMXComp = { cfg: DEFAULTS, loaded: false };

  function fmt(val, kind) {
    var n = Number(val || 0);
    switch (kind) {
      case 'usd':  return '$' + Math.round(n / 100).toLocaleString('en-US');
      case 'usd2': return '$' + (n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      case 'pct':  return (Number.isInteger(n) ? n : parseFloat(n.toFixed(3))) + '%';
      case 'int':  return Math.round(n).toLocaleString('en-US');
      default:     return String(val);
    }
  }
  function apply(cfg) {
    document.querySelectorAll('[data-comp]').forEach(function (el) {
      var spec = el.getAttribute('data-comp');
      var parts = spec.split(':');
      var key = parts[0], kind = parts[1] || 'raw';
      if (cfg[key] != null) el.textContent = fmt(cfg[key], kind);
    });
  }

  LYMXComp.ready = (async function () {
    try {
      var cfg = window.LYMX_CONFIG;
      if (cfg && cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY) {
        var r = await fetch(cfg.SUPABASE_URL + '/rest/v1/rpc/current_commission_config', {
          method: 'POST',
          headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + cfg.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
          body: '{}'
        });
        if (r.ok) {
          var data = await r.json();
          if (data && typeof data === 'object') { LYMXComp.cfg = Object.assign({}, DEFAULTS, data); LYMXComp.loaded = true; }
        }
      }
    } catch (e) { console.warn('[lymx-comp-config] using defaults', e); }
    try { apply(LYMXComp.cfg); } catch (e) { console.warn('[lymx-comp-config] apply() failed; comp values not filled', e); }
    return LYMXComp.cfg;
  })();

  window.LYMXComp = LYMXComp;
})();
