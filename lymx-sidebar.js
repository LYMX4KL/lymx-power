// LYMX sidebar — persistent left-rail navigation for every logged-in page.
// Inspired by InvestPro PM's team-sidebar.js pattern.
//
// Drop this single line into ANY page (before </body>):
//
//     <script src="lymx-sidebar.js" defer></script>
//
// Auto-detects the user's role and shows the appropriate menu. ONLY mounts
// when there's an active Supabase session — public pages, signup pages, and
// logged-out visitors never see it.
//
// On screens <1100px it hides itself to avoid eating content room (the page
// content already has its own narrower layout for mobile).

(function () {
  if (window.__LYMX_SIDEBAR_LOADED__) return;
  window.__LYMX_SIDEBAR_LOADED__ = true;

  // Wait up to 10s for lymx-config.js to load. Some pages place this script
  // BEFORE the config in their HTML, in which case the previous version
  // bailed permanently. (Fix 2026-05-15.)
  function waitForConfig(cb) {
    if (window.LYMX_CONFIG && window.LYMX_CONFIG.SUPABASE_URL) return cb();
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (window.LYMX_CONFIG && window.LYMX_CONFIG.SUPABASE_URL) {
        clearInterval(iv); cb();
      } else if (tries > 100) {
        clearInterval(iv);
        console.warn('[lymx-sidebar] LYMX_CONFIG never loaded; sidebar disabled');
      }
    }, 100);
  }

  // ---------- Session check — bail early if not signed in ------------------
  function projectRefFromUrl() {
    try {
      if (!window.LYMX_CONFIG || !window.LYMX_CONFIG.SUPABASE_URL) return null;
      var m = window.LYMX_CONFIG.SUPABASE_URL.match(/https:\/\/([^.]+)\.supabase\.co/i);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }
  function readStoredToken() {
    try {
      var ref = projectRefFromUrl();
      if (!ref) return null;
      var raw = localStorage.getItem('sb-' + ref + '-auth-token');
      if (!raw) return null;
      var obj = JSON.parse(raw);
      return (obj && obj.access_token)
          || (obj && obj.currentSession && obj.currentSession.access_token)
          || null;
    } catch (e) { return null; }
  }
  function decodeJwt(jwt) {
    try {
      var parts = (jwt || '').split('.');
      if (parts.length !== 3) return null;
      return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    } catch (e) { return null; }
  }
  function isSkippablePath() {
    // Don't show sidebar on entry surfaces (login/signup) or marketing pages
    // even if a session exists. Override with <body data-lymx-sidebar="force">.
    var force = (document.body && document.body.getAttribute('data-lymx-sidebar')) === 'force';
    if (force) return false;
    var path = (location.pathname || '').toLowerCase();
    var skipExact = ['/login.html', '/customer-signup.html', '/biz-signup.html',
                     '/partner-signup.html', '/signup.html', '/'];
    if (skipExact.indexOf(path) >= 0) return true;
    if (/\/index\.html$/.test(path)) return true;
    if (/\/(about|pricing|how-it-works|faq|terms|privacy|legal|accessibility|ai-policy|press|investor|case-stud|partner-charter|partner-vs-mlm|partner-mlm|annual-report|api(\.|-)|webhooks|developer|sitemap|verify-fix)/i.test(path)) return true;
    return false;
  }
  function hasSession() {
    if (isSkippablePath()) return false;
    return !!readStoredToken();
  }

  // ---------- Role detection ----------
  function detectRole() {
    var override = document.body && document.body.getAttribute('data-lymx-role');
    if (override) return override;
    var tok = readStoredToken();
    var payload = decodeJwt(tok);
    if (payload && payload.sub === '1405bb50-2c97-48dd-bfa5-31f32320de9b') return 'admin';
    var path = (location.pathname || '').toLowerCase();
    if (/\/admin-/.test(path) || /admin-dashboard\.html$/.test(path)) return 'admin';
    if (/\/biz-/.test(path) || /biz-dashboard\.html$/.test(path) || /business-dashboard\.html$/.test(path)) return 'business';
    if (/\/(rep-|partner-)/.test(path) || /rep-dashboard\.html$/.test(path)) return 'partner';
    if (/customer-/.test(path) || /\/wallet\.html$/.test(path)) return 'customer';
    return (document.body && document.body.getAttribute('data-role')) || 'customer';
  }

  // ---------- Menu definitions per role ----------
  var MENUS = {
    customer: [
      { section: '🏠 Wallet' },
      { href: 'customer-dashboard.html', icon: '🏠', label: 'Dashboard' },
      { href: 'customer-wallet.html',    icon: '💰', label: 'My LYMX Wallet' },
      { href: 'customer-send-lymx.html', icon: '📤', label: 'Send LYMX' },
      { href: 'browse.html',             icon: '🔍', label: 'Browse Businesses' },
      { section: '🤝 Network' },
      { href: 'refer.html',              icon: '📨', label: 'Refer Friends' },
      { href: 'my-reviews.html',         icon: '⭐', label: 'My Reviews' },
      { href: 'customer-charity.html',   icon: '💝', label: 'Donate LYMX' },
      { section: '⚙️ Account' },
      { href: 'profile.html',            icon: '👤', label: 'Profile' },
      { href: 'contacts.html',           icon: '📇', label: 'Contacts' },
      { href: 'my-feedback.html',        icon: '📝', label: 'My Feedback' },
      { href: 'customer-account-recovery.html', icon: '🔒', label: 'Account Recovery' },
    ],
    business: [
      { section: '📊 Business' },
      { href: 'biz-dashboard.html',      icon: '📊', label: 'Dashboard' },
      { href: 'biz-analytics.html',      icon: '📈', label: 'Analytics' },
      { href: 'biz-customer-data.html',  icon: '👥', label: 'My Customers' },
      { section: '💰 Operations' },
      { href: 'biz-staff-roles.html',    icon: '🪪', label: 'Staff' },
      { href: 'biz-promo-planner.html',  icon: '🎁', label: 'Promo Planner' },
      { href: 'biz-cashflow.html',       icon: '💵', label: 'Cashflow' },
      { href: 'biz-integration.html',    icon: '🔌', label: 'POS / Integrations' },
      { href: 'biz-dispute-handling.html', icon: '⚖️', label: 'Disputes' },
      { section: '📚 Playbooks' },
      { href: 'biz-troubleshoot.html',   icon: '🛠️', label: 'Troubleshoot' },
      { href: 'biz-retention-playbook.html', icon: '🔁', label: 'Retention Playbook' },
      { href: 'biz-peak-prep.html',      icon: '🚀', label: 'Peak-Day Prep' },
      { section: '⚙️ Account' },
      { href: 'profile.html',            icon: '👤', label: 'Profile' },
      { href: 'contacts.html',           icon: '📇', label: 'Contacts' },
      { href: 'my-feedback.html',        icon: '📝', label: 'My Feedback' },
    ],
    partner: [
      { section: '🤝 Partner' },
      { href: 'rep-dashboard.html',      icon: '📊', label: 'Dashboard' },
      { href: 'partner-tree.html',       icon: '🌳', label: 'My Tree' },
      { href: 'partner-leaderboard.html', icon: '🏆', label: 'Leaderboard' },
      { href: 'partner-payouts.html',    icon: '💸', label: 'Payouts' },
      { href: 'partner-crm.html',        icon: '🎯', label: 'My Prospects' },
      { section: '📚 Sales tools' },
      { href: 'partner-pitch-template.html',  icon: '🎤', label: 'Pitch Template' },
      { href: 'partner-discovery-script.html', icon: '🔍', label: 'Discovery Script' },
      { href: 'partner-objections.html',  icon: '🛡️', label: 'Objection Handling' },
      { href: 'partner-followup-templates.html', icon: '📧', label: 'Followup Templates' },
      { href: 'partner-week-1.html',      icon: '📅', label: 'Week 1 Plan' },
      { section: '⚙️ Account' },
      { href: 'profile.html',            icon: '👤', label: 'Profile' },
      { href: 'admin-invite-friends.html', icon: '📨', label: 'Invite Friends' },
      { href: 'contacts.html',           icon: '📇', label: 'Contacts' },
      { href: 'my-feedback.html',        icon: '📝', label: 'My Feedback' },
    ],
    admin: [
      { section: '🛠️ Admin' },
      { href: 'admin-dashboard.html',    icon: '📊', label: 'Dashboard' },
      { href: 'admin-tech-support.html', icon: '🎧', label: 'Tech Support' },
      { href: 'admin-tickets.html',      icon: '🎫', label: 'Tickets' },
      { href: 'admin-chat.html',         icon: '💬', label: 'Team Chat' },
      { href: 'admin-broadcast.html',    icon: '📢', label: 'Broadcast' },
      { href: 'admin-emails.html',       icon: '📧', label: 'Email Events' },
      { href: 'admin-sms.html',          icon: '📱', label: 'SMS' },
      { section: '🏢 Network' },
      { href: 'admin-businesses.html',   icon: '🏢', label: 'Businesses' },
      { href: 'admin-customers.html',    icon: '👥', label: 'Customers' },
      { href: 'admin-promos.html',       icon: '🎁', label: 'Promos' },
      { href: 'admin-approvals.html',    icon: '✅', label: 'Approvals' },
      { href: 'admin-verifications.html', icon: '🪪', label: 'Verifications' },
      { section: '👥 Team' },
      { href: 'admin-team-roster.html',  icon: '🗂️', label: 'Roster' },
      { href: 'admin-timesheets.html',   icon: '⏱️', label: 'Timesheets' },
      { href: 'admin-time-off.html',     icon: '🌴', label: 'Time-off' },
      { href: 'admin-staff.html',        icon: '🪪', label: 'Staff Roles' },
      { href: 'admin-hiring.html',       icon: '📋', label: 'Hiring' },
      { section: '📨 Outreach' },
      { href: 'admin-invite-friends.html', icon: '📨', label: 'Invite Friends' },
      { href: 'contacts.html',           icon: '📇', label: 'Contacts' },
      { section: '⚙️ Account' },
      { href: 'profile.html',            icon: '👤', label: 'Profile' },
      { href: 'my-feedback.html',        icon: '📝', label: 'My Feedback' },
      { href: 'staff-clock-in.html',     icon: '🕐', label: 'Clock In' },
    ]
  };

  // ---------- CSS ----------
  function injectStyles() {
    if (document.getElementById('lymx-sidebar-styles')) return;
    var style = document.createElement('style');
    style.id = 'lymx-sidebar-styles';
    style.textContent = ''
      + '.lymx-sb{position:fixed;left:14px;top:84px;width:232px;max-height:calc(100vh - 100px);overflow-y:auto;background:#fff;border:1px solid #e6e8ec;border-radius:12px;padding:12px 10px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;box-shadow:0 4px 14px rgba(14,17,22,.06);z-index:30}'
      + '.lymx-sb h3{font-size:11px;font-weight:800;color:#0a84ff;margin:6px 8px 4px;padding:0;text-transform:uppercase;letter-spacing:.08em}'
      + '.lymx-sb h3:first-child{margin-top:0}'
      + '.lymx-sb a, .lymx-sb button.lymx-sb-act{display:flex;align-items:center;gap:9px;padding:8px 11px;margin-bottom:2px;background:transparent;border:0;border-radius:7px;color:#1a1f27;text-decoration:none;cursor:pointer;font:600 13px/1.2 inherit;text-align:left;transition:background .12s,color .12s;width:100%}'
      + '.lymx-sb a:hover, .lymx-sb button.lymx-sb-act:hover{background:#eef4ff;color:#0a84ff}'
      + '.lymx-sb a.active{background:#0e1116;color:#fff}'
      + '.lymx-sb a.active:hover{background:#1a1f27;color:#fff}'
      + '.lymx-sb .lymx-sb-icon{font-size:14px;flex-shrink:0;width:18px;text-align:center}'
      + '.lymx-sb .who-mini{padding:8px 11px;margin-bottom:6px;font-size:11.5px;color:#5b6472;border-bottom:1px solid #f1f3f6}'
      + '.lymx-sb .who-mini b{display:block;color:#0e1116;font-size:13px;font-weight:700;margin-bottom:2px;word-break:break-all}'
      + '.lymx-sb .who-mini span.role-tag{display:inline-block;background:#EEF6FF;color:#0a84ff;font-size:10px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;padding:2px 7px;border-radius:999px}'
      + '.lymx-sb .signout{color:#B91C1C}'
      + '.lymx-sb-pushed{padding-left:260px}'
      + '@media(max-width:1100px){'
      + '  .lymx-sb{display:none}'
      + '  .lymx-sb-pushed{padding-left:0}'
      + '}';
    document.head.appendChild(style);
  }

  function buildSidebar(role) {
    var items = MENUS[role] || MENUS.customer;
    var aside = document.createElement('aside');
    aside.className = 'lymx-sb';
    aside.setAttribute('aria-label', role + ' navigation');
    var here = (location.pathname.split('/').pop() || '').toLowerCase();
    var html = '';

    // Who-am-I mini-header
    var payload = decodeJwt(readStoredToken());
    var email = (payload && payload.email) || '';
    if (email) {
      var safe = email.replace(/[<>]/g, '');
      html += '<div class="who-mini"><b>' + safe + '</b>'
            + '<span class="role-tag">' + role + '</span></div>';
    }

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.section) {
        html += '<h3>' + it.section + '</h3>';
      } else {
        var active = (it.href || '').toLowerCase() === here ? ' active' : '';
        html += '<a class="' + active.trim() + '" href="' + it.href + '">'
              + '<span class="lymx-sb-icon" aria-hidden="true">' + (it.icon || '·') + '</span>'
              + '<span class="lymx-sb-label">' + it.label + '</span>'
              + '</a>';
      }
    }
    // Sign-out (always last)
    html += '<button class="lymx-sb-act signout" id="lymx-sb-signout" type="button">'
          + '<span class="lymx-sb-icon">🚪</span><span>Sign out</span></button>';

    aside.innerHTML = html;
    return aside;
  }

  async function doSignout() {
    try {
      if (window.LYMX && window.LYMX.client && window.LYMX.client.auth) {
        await window.LYMX.client.auth.signOut();
      } else if (window.supabase && window.supabase.createClient && window.LYMX_CONFIG) {
        var sb = window.supabase.createClient(window.LYMX_CONFIG.SUPABASE_URL, window.LYMX_CONFIG.SUPABASE_ANON_KEY);
        await sb.auth.signOut();
      } else {
        var ref = projectRefFromUrl();
        if (ref) localStorage.removeItem('sb-' + ref + '-auth-token');
      }
    } catch (e) { console.warn('[lymx-sidebar] signout fallback', e); }
    location.href = '/login.html';
  }

  function mount() {
    if (!document.body) return setTimeout(mount, 50);
    if (document.querySelector('.lymx-sb')) return;
    if (!hasSession()) return;

    injectStyles();
    var role = detectRole();
    var sidebar = buildSidebar(role);
    document.body.appendChild(sidebar);
    document.body.classList.add('lymx-sb-pushed');

    var sout = document.getElementById('lymx-sb-signout');
    if (sout) sout.addEventListener('click', doSignout);

    if (window.LYMX && window.LYMX.client && window.LYMX.client.auth) {
      w