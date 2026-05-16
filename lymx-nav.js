// LYMX universal nav helper — runs on EVERY page via lymx-app.js
//
// What it does:
//  1) On signup / welcome pages: redirect logged-in users to their dashboard
//     so they cannot accidentally create a second account that overwrites
//     their current session.  (Bug fixes #7408a82f, #76fd4085)
//  2) On any page that has guest buttons (Sign In / Sign Up / For Business)
//     in the nav, hide them when the user is signed in and show a single
//     "My account" link routed to the right dashboard.
//     (Bug fixes #ebaec045 wallet, #66eb60ce browse, #84b86c15 welcome,
//      #50bab503 contacts navbar, and similar)
//  3) On pages that have an empty avatar circle in the nav, wire it to a
//     small dropdown (My account, Sign out).  (Bug fix #87201a16)
//
// Idempotent — checks __LYMX_NAV_LOADED__ flag.

(function () {
  if (window.__LYMX_NAV_LOADED__) return;
  window.__LYMX_NAV_LOADED__ = true;

  function waitForConfig(cb) {
    if (window.LYMX_CONFIG && window.LYMX_CONFIG.SUPABASE_URL) return cb();
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (window.LYMX_CONFIG && window.LYMX_CONFIG.SUPABASE_URL) { clearInterval(iv); cb(); }
      else if (tries > 100) { clearInterval(iv); }
    }, 100);
  }

  function projectRef() {
    try {
      var m = (window.LYMX_CONFIG.SUPABASE_URL || '').match(/https:\/\/([^.]+)\.supabase\.co/i);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }
  function readToken() {
    try {
      var ref = projectRef();
      if (!ref) return null;
      var raw = localStorage.getItem('sb-' + ref + '-auth-token');
      if (!raw) return null;
      var obj = JSON.parse(raw);
      return (obj && obj.access_token) || (obj && obj.currentSession && obj.currentSession.access_token) || null;
    } catch (e) { return null; }
  }
  function decode(tok) {
    try {
      var parts = (tok || '').split('.');
      if (parts.length !== 3) return null;
      return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    } catch (e) { return null; }
  }
  function routeFor(payload) {
    if (!payload) return 'customer-dashboard.html';
    if (payload.sub === '1405bb50-2c97-48dd-bfa5-31f32320de9b') return 'admin-dashboard.html';
    var em = (payload.email || '').toLowerCase();
    if (em.endsWith('@lymxpower.com') || em.endsWith('@getlymx.com')) return 'rep-dashboard.html';
    return 'customer-dashboard.html';
  }

  // ---- 1) Redirect signed-in users away from signup / welcome pages -------
  function redirectIfSignedIn(payload) {
    var path = (location.pathname || '').toLowerCase();
    var entryPages = [
      '/welcome.html', '/welcome',
      '/customer-signup.html', '/customer-signup',
      '/biz-signup.html', '/biz-signup',
      '/partner-signup.html', '/partner-signup',
      '/signup.html', '/signup'
    ];
    var isEntry = entryPages.some(function (p) { return path === p || path.endsWith(p); });
    if (!isEntry) return;
    // Always allow when an explicit ?force=1 is on the URL (in case Kenny needs to test the flow)
    if (/[?&]force=1/.test(location.search)) return;
    location.replace(routeFor(payload));
  }

  // ---- 2) Swap guest buttons → "My account" -------------------------------
  function swapGuestButtons(payload) {
    var dest = routeFor(payload);
    // Find anchors that look like guest CTAs in the page chrome
    var guestSelectors = [
      'a[href$="login.html"]',
      'a[href="login.html"]',
      'a[href$="welcome.html"]',
      'a[href="welcome.html"]',
      'a[href$="business.html"]',
      'a[href="business.html"]',
      'a[href$="customer-signup.html"]',
      'a[href$="partner-signup.html"]',
      'a[href$="biz-signup.html"]'
    ];
    var seen = new Set();
    guestSelectors.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (a) {
        // Only swap nav / header / footer area links — skip body content links
        var inNav = a.closest('header, nav, .nav, .topbar, .nav-cta, .header, .top-nav');
        if (!inNav) return;
        // Skip if already swapped
        if (seen.has(a)) return;
        seen.add(a);
        a.style.display = 'none';
      });
    });
    // Inject a single "My account" anchor next to the hidden ones
    // Find the first parent that's a nav-cta-like container.
    var anyHidden = document.querySelector('header a[style*="display: none"], .nav-cta a[style*="display: none"]');
    if (anyHidden && !document.getElementById('lymxNavMyAcct')) {
      var container = anyHidden.parentElement;
      var btn = document.createElement('a');
      btn.id = 'lymxNavMyAcct';
      btn.href = dest;
      btn.textContent = 'My account →';
      btn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:9px;font-weight:700;font-size:13.5px;background:#0e1116;color:#fff;text-decoration:none;border:0';
      container.appendChild(btn);
    }
  }

  // ---- 3) Wire empty avatar circles in nav --------------------------------
  function wireAvatar(payload) {
    var email = (payload && payload.email) || '';
    var initial = (email[0] || 'L').toUpperCase();
    var routes = { route: routeFor(payload) };
    // Common avatar containers (id-based first, then class-based)
    var candidates = [
      '#userInitial', '#userAvatar', '.user-avatar', '.admin-avatar',
      '#headerAvatar', '.nav-avatar'
    ];
    candidates.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) {
        if (el.dataset.lymxWired === '1') return;
        el.dataset.lymxWired = '1';
        if (!el.textContent.trim()) el.textContent = initial;
        el.style.cursor = 'pointer';
        el.title = email || 'Account';
        el.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          showAvatarMenu(el, payload);
        });
      });
    });
  }

  function showAvatarMenu(anchor, payload) {
    // Remove any open menu
    var prev = document.getElementById('lymxAvatarMenu');
    if (prev) { prev.remove(); return; }
    var dest = routeFor(payload);
    var email = (payload && payload.email) || 'Account';
    var menu = document.createElement('div');
    menu.id = 'lymxAvatarMenu';
    menu.style.cssText = 'position:absolute;background:#fff;border:1px solid #e6e8ec;border-radius:10px;box-shadow:0 8px 24px rgba(14,17,22,.12);padding:8px;min-width:200px;z-index:9999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;font-size:13.5px';
    var rect = anchor.getBoundingClientRect();
    menu.style.top = (rect.bottom + window.scrollY + 6) + 'px';
    menu.style.left = (Math.max(8, rect.right - 200) + window.scrollX) + 'px';
    menu.innerHTML =
      '<div style="padding:8px 10px;color:#5b6472;font-size:11.5px;border-bottom:1px solid #f1f3f6;margin-bottom:4px">' + (email.replace(/[<>]/g, '')) + '</div>' +
      '<a href="' + dest + '" style="display:block;padding:8px 10px;border-radius:6px;color:#1a1f27;text-decoration:none">Dashboard</a>' +
      '<a href="profile.html" style="display:block;padding:8px 10px;border-radius:6px;color:#1a1f27;text-decoration:none">Profile</a>' +
      '<a href="my-feedback.html" style="display:block;padding:8px 10px;border-radius:6px;color:#1a1f27;text-decoration:none">My feedback</a>' +
      '<button id="lymxAvatarSignout" type="button" style="display:block;width:100%;text-align:left;padding:8px 10px;border-radius:6px;background:none;border:0;cursor:pointer;color:#B91C1C;font:inherit">Sign out</button>';
    document.body.appendChild(menu);
    menu.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('mouseenter', function () { a.style.background = '#eef4ff'; });
      a.addEventListener('mouseleave', function () { a.style.background = ''; });
    });
    document.getElementById('lymxAvatarSignout').addEventListener('click', function () {
      doSignout();
    });
    // Close on outside click
    setTimeout(function () {
      document.addEventListener('click', function close(e) {
        if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); }
      });
    }, 50);
  }

  async function doSignout() {
    try {
      if (window.LYMX && window.LYMX.client && window.LYMX.client.auth) {
        await window.LYMX.client.auth.signOut();
      } else {
        var ref = projectRef();
        if (ref) localStorage.removeItem('sb-' + ref + '-auth-token');
      }
    } catch (e) {}
    location.href = '/login.html';
  }


  // ---- 4) Admin-page guard — server-side role check on every admin-* page
  // (P0 fix 2026-05-15 #a679ebc0, #3eb48521, #c081e9bf) ---------------------
  async function enforceAdminGuard(payload) {
    var path = (location.pathname || '').toLowerCase();
    var isAdminPage = /\/admin-[^/]*\.html$/.test(path) || /\/admin-[^/]+$/.test(path);
    if (!isAdminPage) return;
    var KENNY_ADMIN = '1405bb50-2c97-48dd-bfa5-31f32320de9b';
    // Fast path: Kenny (hardcoded admin)
    if (payload && payload.sub === KENNY_ADMIN) return;
    // Server check: does this user have an admin row in staff_roles?
    try {
      var ANON = window.LYMX_CONFIG.SUPABASE_ANON_KEY;
      var URL  = window.LYMX_CONFIG.SUPABASE_URL;
      var tok  = readToken();
      var r = await fetch(URL + '/rest/v1/staff_roles?user_id=eq.' + (payload && payload.sub) + '&select=role,is_cfo,is_hr',
        { headers: { apikey: ANON, Authorization: 'Bearer ' + tok } });
      if (!r.ok) { location.replace('/login.html?return=' + encodeURIComponent(path)); return; }
      var rows = await r.json();
      var ok = rows && rows.length && (rows[0].role === 'admin' || rows[0].is_cfo || rows[0].is_hr);
      if (!ok) {
        // Not an admin — kick them to their own dashboard
        var dest = routeFor(payload);
        location.replace(dest);
      }
    } catch (e) {
      location.replace('/login.html?return=' + encodeURIComponent(path));
    }
  }


  // ---- 5) Always-visible Sign In chip for logged-out users -----------------
  // (UX fix 2026-05-16 — Kenny: "user will not come back if they can't find login")
  // Adds a floating "Sign in" pill in the top-right corner on every page
  // where the user isn't already in the nav-cta area. Click goes to
  // /login.html?return=<current> so users land back where they were.
  function injectSignInChip() {
    // Skip on login / signup pages themselves
    var path = (location.pathname || '').toLowerCase();
    if (/login|signup|welcome|verify-fix|recovery/i.test(path)) return;
    // Skip if the page already has a visible Sign in link in its nav-cta
    var existing = document.querySelector('header a[href*="login"], .nav-cta a[href*="login"], #navCtaGuest a[href*="login"]');
    if (existing && existing.offsetParent !== null) return;
    // Don't double-inject
    if (document.getElementById('lymxSignInChip')) return;
    var chip = document.createElement('a');
    chip.id = 'lymxSignInChip';
    var ret = encodeURIComponent(location.pathname + location.search);
    chip.href = 'login.html?return=' + ret;
    chip.innerHTML = '<span style="font-size:14px">→</span><span>Sign in</span>';
    chip.style.cssText = 'position:fixed;top:14px;right:14px;z-index:99990;display:flex;align-items:center;gap:6px;padding:8px 14px;background:#0e1116;color:#fff;border-radius:999px;font-weight:700;font-size:13.5px;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;box-shadow:0 4px 12px rgba(14,17,22,.18);cursor:pointer';
    document.body.appendChild(chip);
  }

  function mount() {
    var tok = readToken();
    if (!tok) {
      injectSignInChip();  // logged-out — show Sign in pill (UX fix 2026-05-16)
      return;
    }
    var payload = decode(tok);
    redirectIfSignedIn(payload);
    enforceAdminGuard(payload);  // P0 guard 2026-05-15
    swapGuestButtons(payload);
    wireAvatar(payload);
  }

  function boot() {
    waitForConfig(function () {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
      else mount();
    });
  }
  boot();
})();
