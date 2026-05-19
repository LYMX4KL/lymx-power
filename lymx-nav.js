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
  function wireAvatar(payload) {
    var email = (payload && payload.email) || '';
    var initial = (email[0] || 'L').toUpperCase();
    var routes = { route: routeFor(payload) };
    // Common avatar containers — id-based first, then class-based.
    // Nav-area only patterns; deliberately skips list-item avatars
    // (mention-avatar, host-avatar, qc-avatar, w-avatar) so they remain
    // clickable for their own item-level handlers.
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
      '<a href="' + dest + '" style="display:block;padding:8px 10px;border-radius:6px;color:#1a1f27;text-decoration:none" data-i18n="nav.dashboard">Dashboard</a>' +
      '<a href="my-conversations.html" style="display:block;padding:8px 10px;border-radius:6px;color:#1a1f27;text-decoration:none">📬 <span data-i18n="nav.messages">Messages</span> <span id="lymxNavMsgBadge" style="display:none;background:#0a84ff;color:#fff;font-size:11px;font-weight:700;padding:1px 7px;border-radius:999px;margin-left:4px"></span></a>' +
      '<a href="profile.html" style="display:block;padding:8px 10px;border-radius:6px;color:#1a1f27;text-decoration:none" data-i18n="nav.profile">Profile</a>' +
      '<a href="my-feedback.html" style="display:block;padding:8px 10px;border-radius:6px;color:#1a1f27;text-decoration:none" data-i18n="nav.my_feedback">My feedback</a>' +
      '<button id="lymxAvatarSignout" type="button" style="display:block;width:100%;text-align:left;padding:8px 10px;border-radius:6px;background:none;border:0;cursor:pointer;color:#B91C1C;font:inherit" data-i18n="nav.sign_out">Sign out</button>';
    // Fetch unread message count and show badge if > 0
    try {
      var ANON2 = window.LYMX_CONFIG && window.LYMX_CONFIG.SUPABASE_ANON_KEY;
      var URL2  = window.LYMX_CONFIG && window.LYMX_CONFIG.SUPABASE_URL;
      var tok2  = readToken();
      if (URL2 && ANON2 && tok2) {
        fetch(URL2 + '/rest/v1/conversations?select=unread_count_subject&unread_count_subject=gt.0',
              { headers: { apikey: ANON2, Authorization: 'Bearer ' + tok2 } })
          .then(function (r) { return r.ok ? r.json() : []; })
          .then(function (rows) {
            var total = (rows || []).reduce(function (s, r) { return s + (r.unread_count_subject || 0); }, 0);
            if (total > 0) {
              var b = document.getElementById('lymxNavMsgBadge');
              if (b) { b.textContent = total; b.style.display = 'inline-block'; }
            }
          }).catch(function(){});
      }
    } catch (e) {}
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

    var brands = document.querySelectorAll('header a.brand, header .brand, header.nav a.brand, .nav-inner a.brand');
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
        + '#lymxNavDrawer{position:fixed;top:0;right:0;height:100%;width:78%;max-width:320px;background:#fff;z-index:99989;transform:translateX(100%);transition:transform .22s ease;display:flex;flex-direction:column;padding:18px 18px 24px;box-shadow:-8px 0 24px rgba(14,17,22,.18)}'
        + '#lymxNavDrawer.open{transform:translateX(0)}'
        + '#lymxNavDrawer .drawer-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid #e6e8ec}'
        + '#lymxNavDrawer .drawer-head .ttl{font-weight:800;font-size:18px;color:#0e1116}'
        + '#lymxNavDrawer .drawer-close{background:transparent;border:0;cursor:pointer;padding:6px;font-size:24px;line-height:1;color:#5b6472;font-family:inherit}'
        + '#lymxNavDrawer a{display:block;padding:13px 12px;color:#0e1116;text-decoration:none;font-weight:600;font-size:15.5px;border-radius:8px;margin-bottom:4px}'
        + '#lymxNavDrawer a:hover,#lymxNavDrawer a:focus{background:#f6f7f9}'
        + '#lymxNavDrawer .drawer-cta{margin-top:auto;padding-top:18px;border-top:1px solid #e6e8ec}'
        + '#lymxNavDrawer .drawer-cta a{background:#0e1116;color:#fff;text-align:center;font-weight:700;margin-top:4px}';
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
        var clone = document.createElement('a');
        clone.href = a.href;
        clone.textContent = a.textContent;
        drawerCta.appendChild(clone);
      });
    }

    function open() { overlay.classList.add('open'); drawer.classList.add('open'); document.body.style.overflow = 'hidden'; }
    function close() { overlay.classList.remove('open'); drawer.classList.remove('open'); document.body.style.overflow = ''; }
    btn.addEventListener('click', open);
    overlay.addEventListener('click', close);
    drawer.addEventListener('click', function (e) {
      if (e.target.closest('a')) close();
    });
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
        return;
      }
      redirectIfSignedIn(payload);
      swapGuestButtons(payload);
      wireAvatar(payload);
      enforceAdminGuard(payload);
      injectMobileHamburger();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

