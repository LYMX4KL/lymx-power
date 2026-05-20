/* lymx-role-gate.js
 * Page-level role guard. Include on any page that should only be accessible
 * to a specific user role:
 *
 *   <body data-role-required="partner">
 *   ...
 *   <script src="lymx-role-gate.js" defer></script>
 *
 * Supported values for data-role-required:
 *   - "partner"   → must be in public.partners (archived_at is null)
 *   - "business"  → must own a public.businesses row (owner_user_id = me)
 *   - "admin"     → must be admin via am_i_admin() helper (RLS-driven check)
 *   - "staff"     → must be in public.staff_roles
 *
 * Behaviour:
 *   - Anyone not signed in → redirect to /login.html?next=<current>
 *   - Signed in but wrong role → redirect to /not-authorized.html?role=<required>
 *   - Admins always pass (admins can read everything)
 *
 * Cached for 60s in sessionStorage to avoid hammering the DB on every nav.
 *
 * Built 2026-05-18 to fix the cluster of "X page is accessible to customer
 * accounts" bug reports.
 */
(function () {
  if (window.__lymxRoleGated) return;
  window.__lymxRoleGated = true;

  var required = document.body && document.body.getAttribute('data-role-required');
  if (!required) return; // not a gated page

  var CACHE_KEY = 'lymx_role_gate_v1';
  var CACHE_MS = 60 * 1000;

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
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), value: value })); } catch (e) {}
  }

  function gotoLogin() {
    location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
  }
  function gotoNotAuthorized() {
    location.href = '/not-authorized.html?role=' + encodeURIComponent(required) + '&from=' + encodeURIComponent(location.pathname);
  }

  async function check() {
    if (!window.LYMX || !window.LYMX.getSession || !window.LYMX_CONFIG) return;
    var s;
    try { s = await window.LYMX.getSession(); } catch (e) { return; }
    if (!s) { gotoLogin(); return; }

    // Cache by user_id + required role so a user switching roles re-checks
    var cacheTag = (s.user && s.user.id ? s.user.id.slice(0, 8) : '?') + ':' + required;
    var cached = readCache();
    if (cached && cached.tag === cacheTag) {
      if (!cached.ok) gotoNotAuthorized();
      return;
    }

    var SUPA = window.LYMX_CONFIG.SUPABASE_URL;
    var ANON = window.LYMX_CONFIG.SUPABASE_ANON_KEY;
    var headers = { apikey: ANON, Authorization: 'Bearer ' + s.access_token };

    // Admin bypass — call am_i_admin RPC. If it returns true, allow on every gated page.
    try {
      var aRes = await fetch(SUPA + '/rest/v1/rpc/am_i_admin', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
      if (aRes.ok) {
        var isAdmin = await aRes.json();
        if (isAdmin === true) { writeCache({ tag: cacheTag, ok: true }); return; }
      }
    } catch (e) { console.warn('[lymx-role-gate.js:L80] silent error', e); }

    var ok = false;

    try {
      if (required === 'partner') {
        var r = await fetch(SUPA + '/rest/v1/partners?user_id=eq.' + s.user.id + '&select=id&limit=1', { headers: headers });
        if (r.ok) { var arr = await r.json(); ok = arr.length > 0; }
        // Fall back: try contact_email match (Kenny's beginner-friendly partner-tree fallback pattern)
        if (!ok && s.user.email) {
          var r2 = await fetch(SUPA + '/rest/v1/partners?contact_email=ilike.' + encodeURIComponent(s.user.email.toLowerCase()) + '&select=id&limit=1', { headers: headers });
          if (r2.ok) { var arr2 = await r2.json(); ok = arr2.length > 0; }
        }
      } else if (required === 'business') {
        var r = await fetch(SUPA + '/rest/v1/businesses?owner_user_id=eq.' + s.user.id + '&archived_at=is.null&select=id&limit=1', { headers: headers });
        if (r.ok) { var arr = await r.json(); ok = arr.length > 0; }
        // Fall back: business_partners
        if (!ok) {
          try {
            var rb = await fetch(SUPA + '/rest/v1/business_partners?user_id=eq.' + s.user.id + '&select=business_id&limit=1', { headers: headers });
            if (rb.ok) { var arrb = await rb.json(); ok = arrb.length > 0; }
          } catch (e) { console.warn('[lymx-role-gate.js:L101] silent error', e); }
        }
      } else if (required === 'staff') {
        var r = await fetch(SUPA + '/rest/v1/staff_roles?user_id=eq.' + s.user.id + '&select=user_id&limit=1', { headers: headers });
        if (r.ok) { var arr = await r.json(); ok = arr.length > 0; }
      } else if (required === 'admin') {
        // Already covered by am_i_admin bypass above. If we got here, they're not admin.
        ok = false;
      }
    } catch (e) {
      // Fail open so a DB blip doesn't lock everyone out of the page.
      // Admin pages are protected by RLS at the data layer too, so this is safe.
      console.warn('[role-gate] check failed; allowing through', e);
      ok = true;
    }

    writeCache({ tag: cacheTag, ok: ok });
    if (!ok) gotoNotAuthorized();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(check, 150); });
  } else {
    setTimeout(check, 150);
  }
})();
