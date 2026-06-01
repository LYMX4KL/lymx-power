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
  // 2026-05-28 — admin role lookup is now session-cached via ensureAdminCache()
  // below. The cache is populated by a real am_i_admin() RPC call at boot, so
  // routeFor and fallbackDashboardForRole no longer special-case Kenny's UUID.
  // Any user whose am_i_admin() returns true gets routed to admin-dashboard.html;
  // the previous hardcoded UUID OR-bypass only worked for one user and silently
  // misrouted every other admin (e.g. Helen) to customer-dashboard.
  function isAdminCached() {
    try { return sessionStorage.getItem('LYMX_is_admin') === '1'; } catch (e) { return false; }
  }
  function setAdminCached(yes) {
    try { sessionStorage.setItem('LYMX_is_admin', yes ? '1' : '0'); } catch (e) { console.warn('[lymx-nav] sessionStorage write', e); }
  }
  function routeFor(payload) {
    if (!payload) return 'customer-dashboard.html';
    if (isAdminCached()) return 'admin-dashboard.html';
    var em = (payload.email || '').toLowerCase();
    if (em.endsWith('@lymxpower.com') || em.endsWith('@getlymx.com')) return 'rep-dashboard.html';
    return 'customer-dashboard.html';
  }

  // Populate the admin cache by asking the server once per session.
  // Uses the canonical am_i_admin() RPC (migration 102) so any role check
  // anywhere in the app stays single-source-of-truth.
  async function ensureAdminCache(payload) {
    if (!payload || !payload.sub) return;
    try {
      if (sessionStorage.getItem('LYMX_is_admin') !== null) return;
    } catch (e) { console.warn('[lymx-nav] sessionStorage probe', e); }
    if (!window.LYMX_CONFIG) return;
    var cfg = window.LYMX_CONFIG;
    var tok = readToken();
    if (!tok) return;
    try {
      var r = await fetch(cfg.SUPABASE_URL + '/rest/v1/rpc/am_i_admin', {
        method: 'POST',
        headers: {
          apikey: cfg.SUPABASE_ANON_KEY,
          Authorization: 'Bearer ' + tok,
          'Content-Type': 'application/json'
        },
        body: '{}'
      });
      if (!r.ok) {
        console.warn('[lymx-nav] am_i_admin RPC failed', r.status);
        setAdminCached(false);
        return;
      }
      var v = await r.json();
      setAdminCached(v === true);
    } catch (e) {
      console.warn('[lymx-nav] am_i_admin RPC error', e);
      setAdminCached(false);
    }
  }

  // ---- 1) Redirect signed-in users away from signup / welcome pages -------
  // 2026-05-20 #8ae35834 — partner-signup.html now routes signed-in
  // non-partner users to partner-upgrade.html (the additive-role flow)
  // instead of bouncing them to their dashboard. That fix RESOLVES the
  // long-standing complaint from Helen + Rachel that "Apply as Partner"
  // was a dead button for anyone already logged in.
  function redirectIfSignedIn(payload) {
    var path = (location.pathname || '').toLowerCase();
    // Partner-signup gets special handling — see below.
    // 2026-05-21 #96814d84 - removed /biz-signup from the auto-bounce list.
    // biz-signup is the form a SIGNED-IN customer fills out to APPLY to become
    // a Business — not a "create a new account" page. Bouncing customers to
    // customer-dashboard prevented the entire customer-to-business pipeline.
    // The same shape that #8ae35834 fixed for partner-signup last week. The
    // biz-signup page itself handles the "you already own a business" case.
    var nonPartnerEntryPages = [
      '/welcome.html', '/welcome',
      '/customer-signup.html', '/customer-signup',
      '/signup.html', '/signup'
    ];
    var partnerEntryPages = ['/partner-signup.html', '/partner-signup'];
    if (/[?&]force=1/.test(location.search)) return; // explicit override

    // 1a. /partner-signup.html — route signed-in users to upgrade flow,
    //     UNLESS they're already a partner (then send to their dashboard).
    if (partnerEntryPages.some(function (p) { return path === p || path.endsWith(p); })) {
      // Quick check via cached role — full check happens on /partner-upgrade.html itself.
      var email = (payload && payload.email) || '';
      var dest = routeFor(payload);
      // Partners (rep-dashboard route) → straight to their dashboard, no upgrade needed.
      if (dest === 'rep-dashboard.html' || /partner|lymxpower\.com|getlymx\.com/i.test(email)) {
        location.replace(dest);
      } else {
        // Customers, businesses, anonymous-authed → upgrade page (which gates again).
        // Preserve any ?ref= sponsor code so it carries through to the upgrade form.
        var qs = location.search || '';
        location.replace('/partner-upgrade.html' + qs);
      }
      return;
    }

    // 1b. Other entry pages — original behaviour (bounce to dashboard).
    if (nonPartnerEntryPages.some(function (p) { return path === p || path.endsWith(p); })) {
      location.replace(routeFor(payload));
    }
  }

  // ---- 2) Swap guest buttons → "My account" -------------------------------
  function swapGuestButtons(payload) {
    var dest = routeFor(payload);
    // Find anchors that look like guest CTAs in the page chrome OR by text content
    var guestSelectors = [
      'a[href$="login.html"]',
      'a[href="login.html"]',
      'a[href$="welcome.html"]',
      'a[href="welcome.html"]',
      'a[href$="business.html"]',
      'a[href="business.html"]',
      'a[href$="customer-signup.html"]',
      'a[href$="partner-signup.html"]',
      'a[href$="biz-signup.html"]',
      'a[href$="signup.html"]',
      'a[href="signup.html"]',
      'a[href*="/login"]',
      'a[href*="/signup"]'
    ];
    var seen = new Set();
    // Combined: links by href + links by visible text (catches "Sign In", "Sign Up", "Sign Up Free", "Get Started", "Join")
    var textPattern = /^(\s*)(sign\s*in|log\s*in|sign\s*up(\s+free)?|join\s*free|get\s*started|join\s+lymx)(\s*→?\s*)$/i;
    // Anchors AND buttons in nav/header
    document.querySelectorAll('header a, header button, nav a, nav button, .nav a, .nav button, .nav-cta a, .nav-cta button, .header a, .top-nav a, .topbar a, .navbar a, .site-header a').forEach(function (el) {
      var txt = (el.textContent || '').trim();
      if (textPattern.test(txt) && !seen.has(el)) {
        seen.add(el);
        el.style.display = 'none';
      }
    });
    guestSelectors.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (a) {
        // Only swap nav / header / footer area links — skip body content links
        var inNav = a.closest('header, nav, .nav, .topbar, .nav-cta, .header, .top-nav, .navbar, .site-header');
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
  // 2026-05-20 #55d7abe7 - was inconsistent: each page had its own gradient
  // CSS for .user-avatar / .avatar-nav, and initials computation varied
  // (some pages: "DB", lymx-nav default: just "D" from email[0]). Now: ALWAYS
  // compute proper 2-letter initials from display_name/email and ALWAYS set a
  // deterministic gradient from a stable palette indexed by the user's id/email
  // hash. Result: every page shows the same color + same initials for the
  // same user.
  function computeInitials(name, email) {
    var src = (name || '').trim();
    if (src) {
      var parts = src.split(/[\s.]+/).filter(Boolean);
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
      if (parts.length === 1 && parts[0].length >= 2) return parts[0].slice(0, 2).toUpperCase();
      if (parts.length === 1) return parts[0][0].toUpperCase();
    }
    var e = (email || '').trim();
    if (e) {
      // Take chars before @, split on . or _ to handle first.last or first_last
      var local = e.split('@')[0];
      var lparts = local.split(/[._-]+/).filter(Boolean);
      if (lparts.length >= 2) return (lparts[0][0] + lparts[1][0]).toUpperCase();
      if (local.length >= 2) return local.slice(0, 2).toUpperCase();
      return local[0].toUpperCase();
    }
    return 'L';
  }
  function avatarGradient(seedStr) {
    var palette = [
      ['#0a84ff','#0050c7'], // blue
      ['#6366f1','#4338ca'], // indigo
      ['#8b5cf6','#6d28d9'], // violet
      ['#ec4899','#be185d'], // pink
      ['#f59e0b','#b45309'], // amber
      ['#13a26b','#047857'], // emerald
      ['#0891b2','#0e7490'], // cyan
      ['#ef4444','#991b1b']  // red
    ];
    var h = 0, s = String(seedStr || 'lymx');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    var pair = palette[Math.abs(h) % palette.length];
    return 'linear-gradient(135deg,' + pair[0] + ',' + pair[1] + ')';
  }

  // 2026-05-20 #a461daa8 — fetch user's avatar_url and paint <img> atop the
  // initials on every avatar circle. Cached per-session.
  async function lookupAvatarUrl(uid) {
    if (!uid || !window.LYMX_CONFIG) return null;
    var cfg = window.LYMX_CONFIG;
    var cacheKey = 'LYMX_avatar_url_' + uid;
    try {
      var cached = sessionStorage.getItem(cacheKey);
      if (cached !== null) return cached || null;
    } catch (e) { console.warn('[lymx-nav] sessionStorage read', e); }
    // Get the stored access token (same pattern lymx-sidebar uses)
    var tok = null;
    try {
      var m = cfg.SUPABASE_URL.match(/https:\/\/([^.]+)\.supabase\.co/i);
      var ref = m ? m[1] : null;
      var raw = ref ? localStorage.getItem('sb-' + ref + '-auth-token') : null;
      if (raw) {
        var obj = JSON.parse(raw);
        tok = (obj && obj.access_token)
            || (obj && obj.currentSession && obj.currentSession.access_token)
            || null;
      }
    } catch (e) { console.warn('[lymx-nav] token read', e); }
    if (!tok) return null;
    async function tryTable(tbl) {
      try {
        var r = await fetch(cfg.SUPABASE_URL + '/rest/v1/' + tbl + '?user_id=eq.' + uid + '&select=avatar_url&limit=1', {
          headers: { 'apikey': cfg.SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + tok }
        });
        if (!r.ok) return null;
        var rows = await r.json();
        return (rows && rows[0] && rows[0].avatar_url) || null;
      } catch (e) { console.warn('[lymx-nav] table read ' + tbl, e); return null; }
    }
    var url = await tryTable('customers');
    if (!url) url = await tryTable('partners');
    try { sessionStorage.setItem(cacheKey, url || ''); } catch (e) { console.warn('[lymx-nav] sessionStorage write', e); }
    return url || null;
  }

  function paintAvatarImage(url) {
    if (!url) return;
    var candidates = [
      '#userInitial', '#userAvatar', '#headerAvatar', '#avatarNav',
      '#avatar', '#bizAvatar', '#repAvatar',
      '.user-avatar', '.admin-avatar', '.nav-avatar', '.avatar-nav',
      '.biz-avatar', '.rep-avatar'
    ];
    candidates.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) {
        if (el.dataset.lymxAvImg === '1') return;
        // Skip if it's the menu-header mini avatar (handled separately)
        if (el.classList && el.classList.contains('lymx-mini-av-in-menu')) return;
        el.dataset.lymxAvImg = '1';
        // Preserve the caret + click handlers; just inject an <img>
        var existing = el.querySelector('img.lymx-av-img');
        if (existing) { existing.src = url; return; }
        var img = document.createElement('img');
        img.className = 'lymx-av-img';
        img.src = url;
        img.alt = '';
        img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:50%;pointer-events:none';
        // 2026-05-20 #a461daa8 - hide the text initials only AFTER the image
        // actually loads. If it fails (deleted from storage / RLS denial /
        // network), restore the initials so we never show a broken-img icon.
        var origText = el.textContent;
        img.onload = function () {
          Array.prototype.forEach.call(el.childNodes, function (n) {
            if (n.nodeType === 3) { n.textContent = ''; }
          });
        };
        img.onerror = function () {
          img.remove();
          el.dataset.lymxAvImg = '';
          // Purge stale cache so we don't keep retrying a dead URL.
          try {
            Object.keys(sessionStorage || {}).forEach(function (k) {
              if (k.indexOf('LYMX_avatar_url_') === 0 && sessionStorage.getItem(k) === url) {
                sessionStorage.removeItem(k);
              }
            });
          } catch (e) { console.warn('[lymx-nav] cache purge after onerror', e); }
        };
        el.appendChild(img);
      });
    });
  }

  function wireAvatar(payload) {
    var email = (payload && payload.email) || '';
    var displayName = (payload && (payload.display_name || payload.name)) || '';
    var seedId = (payload && payload.id) || email || 'lymx';
    var initials = computeInitials(displayName, email);
    var bg = avatarGradient(seedId);
    var routes = { route: routeFor(payload) };
    var candidates = [
      '#userInitial', '#userAvatar', '#headerAvatar', '#avatarNav',
      '#avatar', '#bizAvatar', '#repAvatar',
      '.user-avatar', '.admin-avatar', '.nav-avatar', '.avatar-nav',
      '.biz-avatar', '.rep-avatar'
    ];
    candidates.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) {
        if (el.dataset.lymxWired === '1') return;
        el.dataset.lymxWired = '1';
        // Always force consistent initials + gradient regardless of what the
        // page tried to set. Override inline.
        el.textContent = initials;
        el.style.background = bg;
        el.style.color = '#fff';
        el.style.cursor = 'pointer';
        el.style.position = el.style.position || 'relative';
        el.title = (email ? email + ' — ' : '') + 'Profile, settings, sign out';
        el.setAttribute('aria-label', 'Account menu');
        el.setAttribute('aria-haspopup', 'menu');
        el.setAttribute('role', 'button');
        // 2026-05-20 #98ffcf81 + #524e01c9 - avatar didn't look clickable on mobile.
        // 2026-05-21 #1b2e1ac9 - rolled back the caret badge: testers reported it as
        // "an arrow icon overlapping the profile picture" — cluttered. Instead, use a
        // hover/focus ring to signal clickability without painting a glyph on top of
        // the initials. Removes a stray child span; avatar text reads cleanly as just
        // the initials.
        var prevCaret = el.querySelector('.lymx-av-caret');
        if (prevCaret) prevCaret.remove();
        if (!el.dataset.lymxAvHoverWired) {
          el.dataset.lymxAvHoverWired = '1';
          el.style.transition = (el.style.transition ? el.style.transition + ', ' : '') + 'box-shadow .15s, transform .15s';
          el.addEventListener('mouseenter', function () { el.style.boxShadow = '0 0 0 3px rgba(10,132,255,.22)'; });
          el.addEventListener('mouseleave', function () { el.style.boxShadow = ''; });
          el.addEventListener('focus',      function () { el.style.boxShadow = '0 0 0 3px rgba(10,132,255,.35)'; });
          el.addEventListener('blur',       function () { el.style.boxShadow = ''; });
          el.setAttribute('tabindex', el.getAttribute('tabindex') || '0');
        }
        el.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          showAvatarMenu(el, payload);
        });
      });
    });
    // 2026-05-20 #a461daa8 — async paint photo over initials
    var uid = (payload && payload.id) || (payload && payload.sub) || null;
    if (uid) {
      lookupAvatarUrl(uid).then(paintAvatarImage).catch(function(e){ console.warn('[lymx-nav] avatar lookup', e); });
    }
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
    // 2026-05-20 #9553efbe (consistent icons) + #ee79d549 (Settings & Privacy entry) + #a461daa8 (name + mini-avatar header instead of bare email)
    var displayName = (payload && (payload.display_name || payload.name)) || '';
    var seedId = (payload && payload.id) || email || 'lymx';
    var ini = computeInitials(displayName, email);
    var bg = avatarGradient(seedId);
    var headerHtml =
      '<div style="display:flex;align-items:center;gap:10px;padding:9px 10px 11px;border-bottom:1px solid #f1f3f6;margin-bottom:4px">' +
        '<div style="width:32px;height:32px;border-radius:50%;background:' + bg + ';color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;flex-shrink:0">' + ini + '</div>' +
        '<div style="min-width:0;flex:1">' +
          (displayName ? '<div style="font-weight:700;font-size:13.5px;color:#0e1116;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + displayName.replace(/[<>]/g,'') + '</div>' : '') +
          '<div style="color:#5b6472;font-size:11.5px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:' + (displayName ? '2px' : '0') + '">' + (email.replace(/[<>]/g, '')) + '</div>' +
        '</div>' +
      '</div>';
    menu.innerHTML = headerHtml +
      '<a href="' + dest + '" style="display:block;padding:8px 10px;border-radius:6px;color:#1a1f27;text-decoration:none" data-i18n="nav.dashboard">▦ Dashboard</a>' +
      // 2026-05-31 #43/#44 - Notifications + My LYMX Wallet were absent from the universal
      // account menu for EVERY role (not just partners). Partners reported them missing
      // because they have no other entry point. Both pages (notifications.html,
      // customer-wallet.html) are open to any signed-in user - added here for all roles.
      '<a href="customer-wallet.html" style="display:block;padding:8px 10px;border-radius:6px;color:#1a1f27;text-decoration:none" data-i18n="nav.wallet">💰 My LYMX Wallet</a>' +
      '<a href="notifications.html" style="display:block;padding:8px 10px;border-radius:6px;color:#1a1f27;text-decoration:none"><span>🔔 </span><span data-i18n="nav.notifications">Notifications</span></a>' +
      '<a href="my-conversations.html" style="display:block;padding:8px 10px;border-radius:6px;color:#1a1f27;text-decoration:none">📬 <span data-i18n="nav.messages">Messages</span> <span id="lymxNavMsgBadge" style="display:none;background:#0a84ff;color:#fff;font-size:11px;font-weight:700;padding:1px 7px;border-radius:999px;margin-left:4px"></span></a>' +
      '<a href="profile.html" style="display:block;padding:8px 10px;border-radius:6px;color:#1a1f27;text-decoration:none" data-i18n="nav.profile">👤 Profile</a>' +
      '<a href="customer-settings.html" style="display:block;padding:8px 10px;border-radius:6px;color:#1a1f27;text-decoration:none">⚙️ Settings &amp; Privacy</a>' +
      '<a href="my-feedback.html" style="display:block;padding:8px 10px;border-radius:6px;color:#1a1f27;text-decoration:none" data-i18n="nav.my_feedback">📋 My feedback</a>' +
      '<button id="lymxAvatarSignout" type="button" style="display:block;width:100%;text-align:left;padding:8px 10px;border-radius:6px;background:none;border:0;cursor:pointer;color:#B91C1C;font:inherit" data-i18n="nav.sign_out">↩ Sign out</button>';
    // Fetch unread message count and show badge if > 0
    try {
      var ANON2 = window.LYMX_CONFIG && window.LYMX_CONFIG.SUPABASE_ANON_KEY;
      var URL2  = window.LYMX_CONFIG && window.LYMX_CONFIG.SUPABASE_URL;
      var tok2  = readToken();
      var me2 = null;
      try { me2 = JSON.parse(atob(String(tok2).split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).sub; } catch (e) {}
      // 2026-06-01 #29eedbfd — scope the unread badge to the signed-in user's OWN
      // conversations. The old query summed unread_count_subject across EVERY
      // conversation the user could see, so an admin/staff account (RLS lets them
      // see all) showed everyone's unread (e.g. "77") while their real inbox had a
      // few. There is no conversations.subject_user_id column — a user is the
      // subject via their customer/partner/business id (same resolution as
      // my-conversations.html), so count unread only for threads where I'm subject.
      if (URL2 && ANON2 && tok2 && me2) {
        (function () {
          var H = { apikey: ANON2, Authorization: 'Bearer ' + tok2 };
          var get = function (path) { return fetch(URL2 + path, { headers: H }).then(function (r) { return r.ok ? r.json() : []; }).catch(function(){ return []; }); };
          Promise.all([
            get('/rest/v1/customers?select=id&user_id=eq.' + encodeURIComponent(me2) + '&limit=1'),
            get('/rest/v1/partners?select=id&user_id=eq.' + encodeURIComponent(me2) + '&limit=1'),
            get('/rest/v1/businesses?select=id&owner_user_id=eq.' + encodeURIComponent(me2) + '&limit=1')
          ]).then(function (res) {
            var cId = res[0][0] && res[0][0].id, pId = res[1][0] && res[1][0].id, bId = res[2][0] && res[2][0].id;
            var ors = [];
            if (cId) ors.push('and(subject_type.eq.customer,subject_customer_id.eq.' + cId + ')');
            if (pId) ors.push('and(subject_type.eq.partner,subject_partner_id.eq.' + pId + ')');
            if (bId) ors.push('and(subject_type.eq.business,subject_business_id.eq.' + bId + ')');
            if (!ors.length) return;
            return get('/rest/v1/conversations?select=unread_count_subject&unread_count_subject=gt.0&or=(' + ors.join(',') + ')')
              .then(function (rows) {
                var total = (rows || []).reduce(function (s, r) { return s + (r.unread_count_subject || 0); }, 0);
                if (total > 0) {
                  var b = document.getElementById('lymxNavMsgBadge');
                  if (b) { b.textContent = total; b.style.display = 'inline-block'; }
                }
              });
          }).catch(function (err) { console.warn('[lymx-nav] unread-count fetch', err); });
        })();
      }
    } catch (e) { console.warn('[lymx-nav.js:L280] silent error', e); }
    document.body.appendChild(menu);
    // 2026-05-20 #3cb5968a - rect.right - 200 assumed menu is exactly 200px wide, but min-width:200px lets content push it wider, so the menu would extend past the avatar on the right. Re-measure actual width after insertion and re-anchor so menu's right edge = avatar's right edge precisely.
    try {
      var actualW = menu.offsetWidth || 200;
      menu.style.left = (Math.max(8, rect.right - actualW) + window.scrollX) + 'px';
    } catch (e) { console.warn('[lymx-nav.js:L286] silent error', e); }
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
    } catch (e) { console.warn('[lymx-nav] signOut best-effort', e); }
    location.href = '/login.html';
  }


  // ---- 4) Admin-page guard — server-side role check on every admin-* page
  // (P0 fix 2026-05-15 #a679ebc0, #3eb48521, #c081e9bf) ---------------------
  async function enforceAdminGuard(payload) {
    var path = (location.pathname || '').toLowerCase();
    var isAdminPage = /\/admin-[^/]*\.html$/.test(path) || /\/admin-[^/]+$/.test(path);
    if (!isAdminPage) return;
    // 2026-05-28 — removed the Kenny-UUID fast path. Admin check now goes through
    // am_i_admin() RPC for every user, so any staff_roles admin (Helen, etc.)
    // gets through and any non-admin (including a former admin whose role was
    // revoked) gets kicked. Result is cached in sessionStorage by ensureAdminCache.
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
      setAdminCached(!!ok);
      if (!ok) {
        // Not an admin — kick them to their own dashboard
        var dest = routeFor(payload);
        location.replace(dest);
      }
    } catch (e) {
      console.warn('[lymx-nav] enforceAdminGuard failed', e);
      location.replace('/login.html?return=' + encodeURIComponent(path));
    }
  }


  // ---- 4b) Normalize brand-mark across every page -------------------------
  // (Bug fix 2026-05-19 #23e34806 — Dave: "nav bar logo differs across pages
  //  in appearance, size, or design")
  //
  // Root-cause fix: pages historically authored their own .brand markup —
  // some used <img src="logo.png">, some used the text "LYMX Power", some
  // showed a role-suffix span. Result: same brand rendered three different
  // ways depending on which page you were on.
  //
  // This function rewrites every header .brand element to the canonical
  // brand-mark: a 4-block SVG mark + the "LYMX" wordmark at a fixed size.
  // Any existing role-tag suffix (Business / Admin / Partner) is preserved.
  // Single source of truth — to change the logo, edit ONE function below
  // and every page picks it up.
  function normalizeBrand() {
    // Skip on welcome.html — it shows the co-branded business logo dynamically
    var path = (location.pathname || '').toLowerCase();
    if (/welcome\.html$|^\/welcome$|biz-signup/.test(path)) return;

    // 2026-05-24 — extended selector to cover .logo (used by trust-and-safety,
    // founder-blog, cooperative-charter, etc.) so the canonical 4-block mark
    // gets injected there too, closing Cluster E "uses different logo" tickets.
    var brands = document.querySelectorAll(
      'header a.brand, header .brand, header.nav a.brand, .nav-inner a.brand,' +
      'header a.logo, header .logo, nav a.logo, nav .logo, .nav-inner a.logo, .nav-inner .logo'
    );
    if (!brands.length) return;

    // Canonical mark: inline SVG so it scales crisply at any size.
    // 4 black squares in a 2x2 grid (matches the LYMX brand mark in memory).
    var MARK_SVG =
      '<svg class="lymx-mark" width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" style="flex-shrink:0">' +
      '<rect x="0"  y="0"  width="10" height="10" fill="#0e1116"/>' +
      '<rect x="12" y="0"  width="10" height="10" fill="#0e1116"/>' +
      '<rect x="0"  y="12" width="10" height="10" fill="#0e1116"/>' +
      '<rect x="12" y="12" width="10" height="10" fill="#0e1116"/>' +
      '</svg>';

    brands.forEach(function (brand) {
      if (brand.dataset.lymxBrandNormalized === '1') return;
      // Preserve any role-tag the page added (e.g. <span class="biz-tag">Business</span>)
      var roleTag = brand.querySelector('.biz-tag, .admin-tag, .partner-tag, .role-tag');
      var roleHtml = roleTag ? roleTag.outerHTML : '';
      // Replace inner with canonical: mark + LYMX wordmark + (preserved role tag)
      brand.innerHTML = MARK_SVG +
        '<span class="lymx-wordmark" style="font-weight:800;font-size:20px;letter-spacing:.02em;color:#0e1116">LYMX</span>' +
        roleHtml;
      // Apply consistent layout on the anchor itself
      brand.style.display       = 'inline-flex';
      brand.style.alignItems    = 'center';
      brand.style.gap           = '8px';
      brand.style.textDecoration = 'none';
      // 2026-05-28 #b01254fb — Dave reported "Navbar logo not clickable on partner-signup".
      // Root cause: many pages use <div class="brand"><a href="index.html">LYMX</a></div>.
      // normalizeBrand() above replaces innerHTML, which DELETES the inner <a>. The wordmark
      // span isn't an anchor, so clicks land on a dead <div>. Fix: if the brand element
      // itself isn't an <a>, mark it clickable + wire navigation to index.html (or the
      // role-appropriate dashboard if the user is signed-in — payload param passed in by
      // boot()). Either way: brand always navigates somewhere.
      if (brand.tagName !== 'A') {
        brand.style.cursor = 'pointer';
        brand.setAttribute('role', 'link');
        brand.setAttribute('tabindex', brand.getAttribute('tabindex') || '0');
        brand.setAttribute('aria-label', 'LYMX home');
        if (!brand.dataset.lymxBrandClickWired) {
          brand.dataset.lymxBrandClickWired = '1';
          var go = function () {
            // Default to public home; if a signed-in user has a cached dashboard route,
            // honor it so the brand acts like a "home" link consistent with the rest of nav.
            var dest = 'index.html';
            try {
              var token = readToken();
              var p = decode(token);
              if (p) dest = routeFor(p);
            } catch (e) { console.warn('[lymx-nav] brand-click route lookup failed, falling back to index.html', e); }
            location.href = dest;
          };
          brand.addEventListener('click', function (e) {
            // If user clicked on a child anchor that already has its own href, let it through
            if (e.target.closest && e.target.closest('a[href]')) return;
            e.preventDefault();
            go();
          });
          brand.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
          });
        }
      }
      brand.dataset.lymxBrandNormalized = '1';
    });
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
    chip.innerHTML = '<span style="font-size:14px">→</span><span data-i18n="nav.sign_in">Sign in</span>';
    chip.style.cssText = 'position:fixed;top:14px;right:14px;z-index:99990;display:flex;align-items:center;gap:6px;padding:8px 14px;background:#0e1116;color:#fff;border-radius:999px;font-weight:700;font-size:13.5px;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;box-shadow:0 4px 12px rgba(14,17,22,.18);cursor:pointer';
    document.body.appendChild(chip);
  }


  // ----- Mobile hamburger menu (max-width 880px) --------------------------
  // CSS in most pages hides .nav-links on mobile but offers no replacement.
  // This adds a hamburger button + slide-in drawer with the same links.
  // Added 2026-05-16.
  function injectMobileHamburger() {
    if (document.getElementById('lymxHamburger')) return;
    var header = document.querySelector('header.nav, header[class*="nav"]');
    var navLinks = document.querySelector('.nav-links');
    if (!header) return;
    if (!document.getElementById('lymxHamburgerStyle')) {
      var s = document.createElement('style');
      s.id = 'lymxHamburgerStyle';
      s.textContent = ''
        + '#lymxHamburger{display:none;background:transparent;border:0;cursor:pointer;padding:8px;margin-right:4px;width:40px;height:40px;align-items:center;justify-content:center;font-family:inherit}'
        + '#lymxHamburger span{display:block;width:22px;height:2px;background:#0e1116;position:relative}'
        + '#lymxHamburger span::before,#lymxHamburger span::after{content:"";display:block;width:22px;height:2px;background:#0e1116;position:absolute;left:0}'
        + '#lymxHamburger span::before{top:-7px}#lymxHamburger span::after{top:7px}'
        + '@media (max-width:880px){#lymxHamburger{display:flex}}'
        + '#lymxNavOverlay{display:none;position:fixed;inset:0;background:rgba(14,17,22,.4);z-index:99988}'
        + '#lymxNavOverlay.open{display:block}'
        + '#lymxNavDrawer{position:fixed;top:0;right:0;height:100%;height:100dvh;width:78%;max-width:320px;background:#fff;z-index:99989;transform:translateX(100%);transition:transform .22s ease;display:flex;flex-direction:column;padding:18px 18px 24px;box-shadow:-8px 0 24px rgba(14,17,22,.18)}'
        + '#lymxNavDrawer.open{transform:translateX(0)}'
        + '#lymxNavDrawer .drawer-head{flex:0 0 auto;display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid #e6e8ec}'
        + '#lymxNavDrawer .drawer-head .ttl{font-weight:800;font-size:18px;color:#0e1116}'
        + '#lymxNavDrawer .drawer-close{background:transparent;border:0;cursor:pointer;padding:6px;font-size:24px;line-height:1;color:#5b6472;font-family:inherit}'
        // 2026-05-24 #5a88247a — root-cause fix: make inner nav list scrollable. Was clipping bottom items on signed-in mobile (Sign out, Reviews, etc.) because outer drawer was the only flex column and the nav itself had no overflow rule.
        + '#lymxNavDrawer #lymxNavDrawerLinks{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;margin-right:-6px;padding-right:6px}'
        + '#lymxNavDrawer a{display:block;padding:13px 12px;color:#0e1116;text-decoration:none;font-weight:600;font-size:15.5px;border-radius:8px;margin-bottom:4px}'
        + '#lymxNavDrawer a:hover,#lymxNavDrawer a:focus{background:#f6f7f9}'
        + '#lymxNavDrawer .drawer-cta{flex:0 0 auto;margin-top:auto;padding-top:18px;border-top:1px solid #e6e8ec}'
        + '#lymxNavDrawer .drawer-cta a{background:#0e1116;color:#fff;text-align:center;font-weight:700;margin-top:4px}'
        // 2026-05-25 #15430537 — root-cause for header overlap: ~23 public pages each define their own .btn-biz with padding:7px 12px and font-size:13px, which makes For Business shorter than the My account .btn-primary next to it and feels squished against the search row underneath. Normalizing here injects on every page that loads lymx-nav.js so the fix doesn't have to be repeated in 23 files.
        + 'header.nav .nav-cta .btn-biz,header[class*="nav"] .nav-cta .btn-biz{padding:8px 14px;font-size:13.5px;line-height:1.2;min-height:36px;display:inline-flex;align-items:center}'
        + 'header.nav .nav-cta .btn,header[class*="nav"] .nav-cta .btn{min-height:36px}'
        // 2026-05-25 #0fb8ab93 — dropdown overlay styling baseline: crisp white background, light line border, soft drop shadow. Page-level .nav-more-panel CSS still wins where defined; this is the fallback for pages that don't style their own.
        + 'details.nav-more .nav-more-panel{background:#fff;border:1px solid #e6e8ec;box-shadow:0 10px 30px rgba(14,17,22,.08);border-radius:10px}';
      document.head.appendChild(s);
    }
    var btn = document.createElement('button');
    btn.id = 'lymxHamburger';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open menu');
    btn.innerHTML = '<span></span>';
    var navCta = header.querySelector('.nav-cta');
    if (navCta) navCta.parentNode.insertBefore(btn, navCta);
    else header.appendChild(btn);

    var overlay = document.createElement('div');
    overlay.id = 'lymxNavOverlay';
    var drawer = document.createElement('div');
    drawer.id = 'lymxNavDrawer';
    drawer.innerHTML = '<div class="drawer-head"><div class="ttl">LYMX</div><button class="drawer-close" aria-label="Close menu">x</button></div><nav id="lymxNavDrawerLinks"></nav><div class="drawer-cta"></div>';
    document.body.appendChild(overlay);
    document.body.appendChild(drawer);

    var drawerLinks = drawer.querySelector('#lymxNavDrawerLinks');
    if (navLinks) {
      navLinks.querySelectorAll('a').forEach(function (a) {
        // 2026-05-21 #92d9a328 fix: skip cloning links that swapGuestButtons already hid
        // (e.g. "Sign in", "Sign up", "Join LYMX" for logged-in users). Without this skip,
        // the mobile drawer leaks guest links to authenticated users — exactly Rae's bug.
        if (a.style.display === 'none' || getComputedStyle(a).display === 'none') return;
        var clone = document.createElement('a');
        clone.href = a.href;
        clone.textContent = a.textContent;
        drawerLinks.appendChild(clone);
      });
    } else {
      [['index.html', 'Home'], ['browse.html', 'Browse Businesses'], ['partners.html', 'Partners'], ['community.html', 'Community']].forEach(function (item) {
        var a = document.createElement('a');
        a.href = item[0];
        a.textContent = item[1];
        drawerLinks.appendChild(a);
      });
    }

    var drawerCta = drawer.querySelector('.drawer-cta');
    if (navCta) {
      navCta.querySelectorAll('a').forEach(function (a) {
        // 2026-05-21 #92d9a328 fix: same as above for the drawer CTA section.
        // Skip links the swap logic already hid so the drawer respects auth state.
        if (a.style.display === 'none' || getComputedStyle(a).display === 'none') return;
        var clone = document.createElement('a');
        clone.href = a.href;
        clone.textContent = a.textContent;
        drawerCta.appendChild(clone);
      });
    }

    // 2026-05-24 — Cluster J fix: on signed-in pages the lymx-sb sidebar
    // is the actual nav (Wallet, Profile, My Feedback, Sign out, etc.) but
    // it's CSS-hidden on mobile, leaving the hamburger drawer pulling only
    // the marketing top-nav links. Now when the drawer opens we mirror the
    // currently-mounted sidebar items into it — so a signed-in user sees
    // the SAME role-specific menu in the drawer as on desktop. We rebuild
    // on every open() so role changes (partner/customer toggle, sign-out)
    // are reflected without stale state.
    function syncDrawerWithSidebar() {
      var sidebar = document.querySelector('.lymx-sb');
      if (!sidebar) return;
      var existingLinks = drawerLinks ? drawerLinks.querySelectorAll('a') : [];
      // Keep marketing links AND append a separator + sidebar items. Avoid
      // doubling up on subsequent opens: if we've already mirrored, skip.
      if (drawer.dataset.lymxSidebarMirrored === '1') return;
      var sbAnchors = sidebar.querySelectorAll('a, button.lymx-sb-act');
      if (!sbAnchors.length) return;
      // Insert a visual separator if there were existing marketing links.
      if (drawerLinks && existingLinks.length) {
        var hr = document.createElement('div');
        hr.style.cssText = 'margin:10px 0;border-top:1px solid #e6e8ec;padding-top:8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5b6472;font-weight:800;padding-left:12px';
        hr.textContent = 'Your account';
        drawerLinks.appendChild(hr);
      }
      sbAnchors.forEach(function (el) {
        // Skip sign-out: keep it in the marketing drawer-cta block at bottom
        // so it's visually distinct (red) and not buried mid-list.
        if (el.id === 'lymx-sb-signout') return;
        var clone = document.createElement('a');
        clone.href = el.getAttribute('href') || '#';
        // Use textContent so emoji icons + labels both survive
        clone.textContent = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (clone.textContent) drawerLinks.appendChild(clone);
      });
      // Add Sign out as a distinct CTA at the bottom if not already present.
      if (drawerCta && !drawerCta.querySelector('[data-lymx-signout]')) {
        var sout = document.createElement('a');
        sout.href = '#';
        sout.textContent = 'Sign out';
        sout.setAttribute('data-lymx-signout', '1');
        sout.style.color = '#fff';
        sout.style.background = '#B91C1C';
        sout.addEventListener('click', function (e) {
          e.preventDefault();
          if (window.LYMX && window.LYMX.signOut) { window.LYMX.signOut(); }
          else { location.href = '/login.html'; }
        });
        drawerCta.appendChild(sout);
      }
      drawer.dataset.lymxSidebarMirrored = '1';
    }

    function open() {
      try { syncDrawerWithSidebar(); } catch (e) { console.warn('[lymx-nav] drawer sync', e); }
      overlay.classList.add('open');
      drawer.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
    function close() { overlay.classList.remove('open'); drawer.classList.remove('open'); document.body.style.overflow = ''; }
    btn.addEventListener('click', open);
    overlay.addEventListener('click', close);
    drawer.addEventListener('click', function (e) {
      if (e.target.closest('a')) close();
    });
  }

  // ---- 6) Universal "Back" chip ------------------------------------------
  // 2026-05-24 T-7E63CE -- Kenny: "Can't go back to previous page or dashboard"
  // on admin-business-applications.html. Root-cause fix: every deep page across
  // the site needs a back affordance, not just the one Kenny noticed. Floating
  // chip top-left mirrors the sign-in chip (top-right) pattern. Same z-layer
  // as the mobile drawer overlay (99989) so it sits below the sign-in chip
  // (99990) but above page content.
  //
  // Behavior:
  //   - Click -> history.back() if we came from within getlymx.com, otherwise
  //     fall back to the role-appropriate dashboard. Never leaves the site.
  //   - Hidden on top-level/landing pages where "back" is meaningless
  //     (home, login, signup, dashboards, welcome flow). The chip is meant
  //     for deep pages, not landings.
  //   - Auto-positions to avoid the 240px-wide sidebar on desktop signed-in
  //     pages; collapses to a small top-left placement on mobile (<880px)
  //     where the sidebar is hidden behind the hamburger drawer.
  function isDeepPage() {
    var path = (location.pathname || '/').toLowerCase().replace(/\/+$/, '');
    if (path === '' || path === '/index.html') path = '/';
    var roots = [
      '/', '/home.html', '/index.html',
      '/login.html', '/customer-signup.html', '/biz-signup.html',
      '/partner-signup.html', '/welcome.html',
      '/customer-dashboard.html', '/biz-dashboard.html',
      '/partner-dashboard.html', '/admin-dashboard.html',
      '/rep-dashboard.html', '/marketing-dashboard.html',
      '/hr-dashboard.html'
    ];
    if (/verify-fix|recovery|reset|forgot|magic-link/i.test(path)) return false;
    return roots.indexOf(path) === -1;
  }

  function fallbackDashboardForRole(payload) {
    // Mirrors routeFor()'s decision tree so the fallback is consistent with
    // the rest of the nav (sign-in redirect, swap-guest-buttons, avatar menu).
    if (!payload) return 'home.html';
    if (isAdminCached()) return 'admin-dashboard.html';
    var em = (payload.email || '').toLowerCase();
    if (em.endsWith('@lymxpower.com') || em.endsWith('@getlymx.com')) return 'rep-dashboard.html';
    var role = (payload.user_metadata && payload.user_metadata.role)
            || (payload.app_metadata && payload.app_metadata.role)
            || payload.role || '';
    switch (String(role).toLowerCase()) {
      case 'admin':     return 'admin-dashboard.html';
      case 'partner':   return 'rep-dashboard.html';
      case 'business':  return 'biz-dashboard.html';
      case 'marketing': return 'marketing-dashboard.html';
      case 'rep':       return 'rep-dashboard.html';
      case 'hr':        return 'hr-dashboard.html';
      case 'customer':  return 'customer-dashboard.html';
      default:          return 'customer-dashboard.html';
    }
  }

  function injectBackChip(payload) {
    if (!isDeepPage()) return;
    if (document.getElementById('lymxBackChip')) return;
    if (!document.getElementById('lymxBackChipStyle')) {
      var s = document.createElement('style');
      s.id = 'lymxBackChipStyle';
      s.textContent = ''
        + '#lymxBackChip{position:fixed;top:66px;left:260px;z-index:99989;display:inline-flex;align-items:center;gap:6px;padding:8px 14px;background:#fff;color:#0e1116;border:1px solid #e6e8ec;border-radius:999px;font-weight:700;font-size:13.5px;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;box-shadow:0 4px 12px rgba(14,17,22,.10);cursor:pointer;line-height:1}'
        + '#lymxBackChip:hover{background:#f6f7f9;border-color:#d1d5db}'
        + '#lymxBackChip .arr{font-size:15px;line-height:1;margin-top:-1px}'
        + '@media (max-width:880px){#lymxBackChip{left:14px;top:60px}}'
        + 'body:not([data-role-required]):not([data-lymx-sidebar="force"]) #lymxBackChip{left:14px;top:84px}'
        + '@media print{#lymxBackChip{display:none}}';
      document.head.appendChild(s);
    }
    var chip = document.createElement('a');
    chip.id = 'lymxBackChip';
    chip.href = '#';
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-label', 'Back to previous page');
    chip.innerHTML = '<span class="arr" aria-hidden="true">&larr;</span><span data-i18n="nav.back">Back</span>';
    chip.addEventListener('click', function (ev) {
      ev.preventDefault();
      var ref = document.referrer || '';
      var sameOrigin = ref && ref.indexOf(location.origin) === 0;
      if (sameOrigin && window.history.length > 1) {
        window.history.back();
      } else {
        location.href = fallbackDashboardForRole(payload);
      }
    });
    document.body.appendChild(chip);
  }


  // ---- Auth payload helper -------------------------------------------------
  function getAuthPayload() {
    return decode(readToken());
  }

  // ---- Run on DOMContentLoaded ---------------------------------------------
  function boot() {
    // Brand normalization runs first, in both signed-in and signed-out paths.
    // It does not depend on Supabase config, so it runs synchronously.
    normalizeBrand();
    waitForConfig(function () {
      var payload = getAuthPayload();
      if (!payload) {
        injectSignInChip();
        injectMobileHamburger();
        injectBackChip(null);
        return;
      }
      // 2026-05-28 — populate admin cache in the background so subsequent
      // routeFor / fallbackDashboardForRole calls have the truth without each
      // page making its own RPC. First page load on a new session may route by
      // email-suffix fallback until the RPC returns; enforceAdminGuard below
      // also updates the cache as a side effect when an admin lands directly
      // on /admin-*.html.
      ensureAdminCache(payload);
      redirectIfSignedIn(payload);
      swapGuestButtons(payload);
      wireAvatar(payload);
      enforceAdminGuard(payload);
      injectMobileHamburger();
      injectBackChip(payload);
      hideGetAppInPwa();
    });
  }

  // 2026-05-20 #d220c320 — When the page is running as an installed PWA
  // (standalone display-mode on Android/Chrome, navigator.standalone on iOS),
  // hide every "Get the app" / "Install app" CTA across the site. Per-page
  // detection existed on customer-dashboard but nowhere else, so the same
  // user kept seeing the same prompt on every other page.
  function hideGetAppInPwa() {
    try {
      var standalone =
        (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        window.navigator.standalone === true ||
        (document.referrer && document.referrer.indexOf('android-app://') === 0);
      if (!standalone) return;
      var selectors = ['#getAppCta', '#navGetApp', '.get-app-cta', '.install-app-cta', '[data-lymx-hide-in-pwa]'];
      selectors.forEach(function (sel) {
        document.querySelectorAll(sel).forEach(function (el) { el.style.display = 'none'; });
      });
      // Catch-all by visible text — covers any "Get the app" / "Install app"
      // anchor that's not tagged with one of the IDs/classes above.
      var anchors = document.querySelectorAll('a, button');
      var rx = /^(?:\s*)?(get the app|install (?:the )?app|download (?:the )?app)(?:\s*)?$/i;
      anchors.forEach(function (a) {
        var txt = (a.textContent || '').trim();
        if (rx.test(txt)) a.style.display = 'none';
      });
    } catch (e) { console.warn('[lymx-nav] PWA hide-getapp failed', e); }
  }

  // 2026-05-20 #a461daa8 — expose avatar helpers so pages with custom avatar
  // markup (.profile .av, .av-lg, custom IDs) can paint without re-fetching.
  window.LYMX = window.LYMX || {};
  window.LYMX.lookupAvatarUrl = lookupAvatarUrl;
  window.LYMX.paintAvatarOn = function (el, url) {
    if (!el || !url) return;
    if (el.dataset.lymxAvImg === '1') return;
    el.dataset.lymxAvImg = '1';
    el.style.position = el.style.position || 'relative';
    el.style.overflow = el.style.overflow || 'hidden';
    var img = document.createElement('img');
    img.src = url; img.alt = '';
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:50%;pointer-events:none';
    // 2026-05-20 #a461daa8 - only hide initials AFTER successful load.
    img.onload = function () {
      Array.prototype.forEach.call(el.childNodes, function (n) {
        if (n.nodeType === 3) { n.textContent = ''; }
      });
    };
    img.onerror = function () {
      img.remove();
      el.dataset.lymxAvImg = '';
      try {
        Object.keys(sessionStorage || {}).forEach(function (k) {
          if (k.indexOf('LYMX_avatar_url_') === 0 && sessionStorage.getItem(k) === url) {
            sessionStorage.removeItem(k);
          }
        });
      } catch (e) { console.warn('[lymx-nav] cache purge after onerror', e); }
    };
    el.appendChild(img);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
