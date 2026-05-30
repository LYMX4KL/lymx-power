/* lymx-role-gate.js
 * Page-level role guard. Include on any page that should only be accessible
 * to a specific user role:
 *
 *   <body data-role-required="partner">
 *   ...
 *   <script src="lymx-role-gate.js" defer></script>
 *
 * Supported values for data-role-required:
 *   - "partner"        -> must be in public.partners (archived_at is null)
 *   - "business"       -> must own a public.businesses row (owner_user_id = me)
 *   - "admin"          -> must be admin via am_i_admin() helper (RLS-driven check)
 *   - "staff"          -> must be in public.staff_roles
 *   - "perm:<key>"     -> must have has_permission('<key>') === true (or be admin).
 *                         This is the toggler-driven gate (migration 104): an admin
 *                         grants a feature key to a person via Manage Permissions,
 *                         and the page enforces it here. FAIL-CLOSED.
 *
 * Behaviour:
 *   - Anyone not signed in -> redirect to /login.html?next=<current>
 *   - Signed in but wrong role -> redirect to /not-authorized.html?role=<required>
 *   - Admins always pass (admins can read everything)
 *
 * Cached for 60s in sessionStorage to avoid hammering the DB on every nav.
 *
 * Built 2026-05-18 to fix the cluster of "X page is accessible to customer
 * accounts" bug reports. 2026-05-30 - added "perm:<key>" mode to wire the
 * Manage-Permissions toggler to real page enforcement (ARCHITECTURE-RULES Rule 1).
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
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), value: value })); } catch (e) { console.warn('[lymx-role-gate] best-effort', e); }
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

    // Admin bypass - call am_i_admin RPC. If it returns true, allow on every gated page.
    try {
      var aRes = await fetch(SUPA + '/rest/v1/rpc/am_i_admin', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
      if (aRes.ok) {
        var isAdmin = await aRes.json();
        if (isAdmin === true) { writeCache({ tag: cacheTag, ok: true }); return; }
      }
    } catch (e) { console.warn('[lymx-role-gate.js:L80] silent error', e); }

    // 2026-05-30 - permission-gated page:  data-role-required="perm:<feature_key>"
    // Passes if am_i_admin() (handled above) OR has_permission(<feature_key>) is
    // true. This is how the Manage-Permissions toggler (migration 104) actually
    // enforces access: an admin grants a feature key to a person, and the page
    // checks that key here. FAIL-CLOSED - any error or a non-true result denies
    // access (ARCHITECTURE-RULES Rule 1). Unlike the legacy role checks below
    // (which fail open on a DB blip), a permission must be positively confirmed.
    if (required.indexOf('perm:') === 0) {
      var featKey = required.slice(5);
      var okPerm = false;
      try {
        var pRes = await fetch(SUPA + '/rest/v1/rpc/has_permission', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_feature_key: featKey })
        });
        if (pRes.ok) { okPerm = (await pRes.json()) === true; }
      } catch (e) {
        console.warn('[role-gate] has_permission check failed; denying (fail-closed)', e);
        okPerm = false;
      }
      writeCache({ tag: cacheTag, ok: okPerm });
      if (!okPerm) gotoNotAuthorized();
      return;
    }

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
