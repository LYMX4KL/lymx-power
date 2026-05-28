/* lymx-shift-gate.js
 * Auto-redirects to /off-hours.html if the current user is OFF-shift.
 *
 * Usage:
 *   <script src="lymx-shift-gate.js" defer></script>
 *
 * Drop into every "work-only" page (leads.html, team-calendar.html,
 * admin-conversations.html, staff-clock-in.html, etc). Pages that should
 * be available 24/7 (rep-dashboard, partner-tree, profile, etc) just
 * leave it out.
 *
 * How it works:
 *   1. Wait for window.LYMX session
 *   2. Check if the user has any staff_roles row. If not, do nothing (they're
 *      a customer/business, not staff).
 *   3. Call fn_is_on_shift_now(user_id). If false → window.location = off-hours.html.
 *   4. Admins (am_i_admin) bypass the gate — they're always on.
 *
 * Result is cached in sessionStorage for 60 seconds to avoid hammering the DB.
 */
(function () {
  if (window.__lymxShiftGated) return;
  window.__lymxShiftGated = true;

  var CACHE_KEY = 'lymx_shift_gate_v1';
  var CACHE_MS  = 60 * 1000;

  function readCache() {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (Date.now() - obj.at > CACHE_MS) return null;
      return obj.value;
    } catch (e) { return null; }
  }
  function writeCache(value) {
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), value: value })); } catch (e) { console.warn('[lymx-shift-gate] best-effort', e); }
  }

  function go(verdict) {
    // verdict: 'on' | 'off' | 'not_staff' | 'admin'
    if (verdict === 'off') {
      // Avoid loop if we're already on the off-hours page
      if (/\/off-hours\.html/i.test(location.pathname)) return;
      location.href = '/off-hours.html';
    }
    // 'on', 'admin', 'not_staff' → do nothing (let page load)
  }

  async function check() {
    // Cache: skip if we just checked
    var cached = readCache();
    if (cached) { go(cached); return; }

    if (!window.LYMX || !window.LYMX.getSession || !window.LYMX_CONFIG) return;
    var s;
    try { s = await window.LYMX.getSession(); } catch (e) { return; }
    if (!s) return;

    var SUPA = window.LYMX_CONFIG.SUPABASE_URL;
    var ANON = window.LYMX_CONFIG.SUPABASE_ANON_KEY;
    var headers = { apikey: ANON, Authorization: 'Bearer ' + s.access_token, 'Content-Type':'application/json' };

    // 1) Is this user even in staff_roles? If not, gate doesn't apply.
    try {
      var sr = await fetch(SUPA + '/rest/v1/staff_roles?user_id=eq.' + s.user.id + '&select=role,user_id&limit=1', { headers: headers });
      if (!sr.ok) { writeCache('not_staff'); go('not_staff'); return; }
      var arr = await sr.json();
      if (!arr.length) { writeCache('not_staff'); go('not_staff'); return; }

      // 2) Admins bypass the gate
      if (arr[0].role === 'admin') { writeCache('admin'); go('admin'); return; }
    } catch (e) { return; }

    // 3) Call fn_is_on_shift_now
    try {
      var r = await fetch(SUPA + '/rest/v1/rpc/fn_is_on_shift_now', {
        method: 'POST', headers: headers,
        body: JSON.stringify({ p_user_id: s.user.id })
      });
      if (!r.ok) return; // fail-open: don't lock people out on errors
      var onShift = await r.json(); // returns boolean
      var verdict = onShift ? 'on' : 'off';
      writeCache(verdict);
      go(verdict);
    } catch (e) { console.warn('[lymx-shift-gate] verdict resolution failed, failing open', e); }
  }

  // Run after auth has had a chance to load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(chec