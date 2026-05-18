// LYMX sidebar — persistent left-rail navigation for every logged-in page.
//
// Drop this single line into ANY page (before </body>):
//
//     <script src="lymx-sidebar.js" defer></script>
//
// Auto-detects the user's role and shows the appropriate menu. ONLY mounts
// when there's an active Supabase session — public pages, signup pages, and
// logged-out visitors never see it.

(function () {
  if (window.__LYMX_SIDEBAR_LOADED__) return;
  window.__LYMX_SIDEBAR_LOADED__ = true;

  // Wait up to 10s for lymx-config.js to load. (Fix 2026-05-15.)
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

  function detectRole() {
    var override = document.body && document.body.getAttribute('data-lymx-role');
    if (override) return override;
    var tok = readStoredToken();
    var payload = decodeJwt(tok);
    if (payload && payload.sub === '1405bb50-2c97-48dd-bfa5-31f32320de9b') return 'admin';
    var path = (location.pathname || '').toLowerCase();
    if (/\/admin-/.test(path) || /admin-dashboard\.html$/.test(path)) return 'admin';
    if (/\/biz-/.test(path) || /biz-dashboard\.html$/.test(path)) return 'business';
    if (/\/(rep-|partner-)/.test(path) || /rep-dashboard\.html$/.test(path)) return 'partner';
    if (/customer-/.test(path) || /\/wallet\.html$/.test(path)) return 'customer';
    return (document.body && document.body.getAttribute('data-role')) || 'customer';
  }

  var MENUS = {
    customer: [
      { section: 'Wallet' },
      { href: 'customer-dashboard.html', icon: '\u{1F3E0}', label: 'Dashboard' },
      { href: 'customer-wallet.html',    icon: '\u{1F4B0}', label: 'My LYMX Wallet' },
      { href: 'customer-send-lymx.html', icon: '\u{1F4E4}', label: 'Send LYMX' },
      { href: 'browse.html',             icon: '\u{1F50D}', label: 'Browse Businesses' },
      { section: 'Network' },
      { href: 'refer.html',              icon: '\u{1F4E8}', label: 'Refer Friends' },
      { href: 'my-bookings.html',        icon: '\u{1F4C5}', label: 'My bookings' },
      { href: 'my-reviews.html',         icon: '⭐',    label: 'My Reviews' },
      { href: 'my-saved-places.html',   icon: '\u{1F4CC}', label: 'Saved Places' },
      { href: 'customer-charity.html',   icon: '\u{1F49D}', label: 'Donate LYMX' },
      { section: 'Account' },
      { href: 'my-conversations.html',   icon: '\u{1F4EC}', label: 'Messages' },
      { href: 'profile.html',            icon: '\u{1F464}', label: 'Profile' },
      { href: 'contacts.html',           icon: '\u{1F4C7}', label: 'Contacts' },
      { href: 'my-feedback.html',        icon: '\u{1F4DD}', label: 'My Feedback' }
    ],
    business: [
      { section: 'Business' },
      { href: 'biz-dashboard.html',      icon: '\u{1F4CA}', label: 'Dashboard' },
      { href: 'biz-analytics.html',      icon: '\u{1F4C8}', label: 'Analytics' },
      { href: 'biz-customer-data.html',  icon: '\u{1F465}', label: 'My Customers' },
      { section: 'Operations' },
      { href: 'biz-staff-roles.html',    icon: '\u{1FAAA}', label: 'Staff' },
      { href: 'biz-promo-planner.html',  icon: '\u{1F381}', label: 'Promo Planner' },
      { href: 'biz-cashflow.html',       icon: '\u{1F4B5}', label: 'Cashflow' },
      { href: 'biz-payouts.html',        icon: '\u{1F3E6}', label: 'Payouts (Stripe)' },
      { href: 'biz-pos-comparison.html', icon: '\u{1F50C}', label: 'POS / Integrations' },
      { href: 'my-bookings.html',        icon: '\u{1F4C5}', label: 'My bookings' },
      { section: 'Account' },
      { href: 'my-conversations.html',   icon: '\u{1F4EC}', label: 'Messages' },
      { href: 'profile.html',            icon: '\u{1F464}', label: 'Profile' },
      { href: 'contacts.html',           icon: '\u{1F4C7}', label: 'Contacts' },
      { href: 'my-feedback.html',        icon: '\u{1F4DD}', label: 'My Feedback' }
    ],
    partner: [
      { section: 'Partner' },
      { href: 'rep-dashboard.html',      icon: '\u{1F4CA}', label: 'Dashboard' },
      { href: 'partner-tree.html',       icon: '\u{1F333}', label: 'My Tree' },
      { href: 'partner-leaderboard.html', icon: '\u{1F3C6}', label: 'Leaderboard' },
      { href: 'partner-payouts.html',    icon: '\u{1F4B8}', label: 'Payouts' },
      { href: 'prospects.html',          icon: '\u{1F3AF}', label: 'My Prospects' },
      { href: 'team-calendar.html',      icon: '\u{1F4C5}', label: 'My Calendar' },
      { href: 'my-bookings.html',        icon: '\u{1F4DD}', label: 'My bookings' },
      { section: 'Team' },
      { href: 'staff-clock-in.html',     icon: '⏱',    label: 'Clock In' },
      { href: 'my-schedule.html',        icon: '\u{1F4C5}', label: 'My Schedule' },
      { href: 'my-time-off.html',        icon: '\u{1F334}', label: 'My Time-off' },
      { section: 'Account' },
      { href: 'my-conversations.html',   icon: '\u{1F4EC}', label: 'Messages' },
      { href: 'profile.html',            icon: '\u{1F464}', label: 'Profile' },
      { href: 'admin-invite-friends.html', icon: '\u{1F4E8}', label: 'Invite Friends' },
      { href: 'contacts.html',           icon: '\u{1F4C7}', label: 'Contacts' },
      { href: 'my-feedback.html',        icon: '\u{1F4DD}', label: 'My Feedback' }
    ],
    admin: [
      { section: 'Admin' },
      { href: 'admin-dashboard.html',    icon: '\u{1F4CA}', label: 'Dashboard' },
      { href: 'admin-conversations.html', icon: '\u{1F4EC}', label: 'Conversations' },
      { href: 'admin-tech-support.html', icon: '\u{1F3A7}', label: 'Tech Support' },
      { href: 'admin-tickets.html',      icon: '\u{1F3AB}', label: 'Tickets' },
      { href: 'admin-chat.html',         icon: '\u{1F4AC}', label: 'Team Chat' },
      { href: 'admin-broadcast.html',    icon: '\u{1F4E2}', label: 'Broadcast' },
      { href: 'admin-compose-email.html', icon: '✉\uFE0F', label: 'Compose Email' },
      { href: 'admin-emails.html',       icon: '\u{1F4E7}', label: 'Email Events' },
      { href: 'admin-sms.html',          icon: '\u{1F4F1}', label: 'SMS' },
      { section: 'Network' },
      { href: 'leads.html',              icon: '\u{1F4CC}', label: 'Leads' },
      { href: 'admin-bookings.html',     icon: '\u{1F4CB}', label: 'All bookings' },
      { href: 'admin-businesses.html',   icon: '\u{1F3E2}', label: 'Businesses' },
      { href: 'admin-business-applications.html', icon: '\u{1F4DD}', label: 'Biz Applications' },
      { href: 'admin-customers.html',    icon: '\u{1F465}', label: 'Customers' },
      { href: 'admin-promos.html',       icon: '\u{1F381}', label: 'Promos' },
      { href: 'admin-approvals.html',    icon: '✅',    label: 'Approvals' },
      { href: 'admin-reviews.html',      icon: '⭐',    label: 'Review Verification' },
      { href: 'admin-onboarding-calendar.html', icon: '\u{1F4C5}', label: 'Onboarding Calendar' },
      { href: 'team-calendar.html',      icon: '\u{1F5D3}', label: 'My Calendar' },
      { href: 'admin-verifications.html', icon: '\u{1FAAA}', label: 'Verifications' },
      { section: 'Team' },
      { href: 'staff-clock-in.html',     icon: '⏱',    label: 'Clock In' },
      { href: 'admin-schedule.html',     icon: '\u{1F4C5}', label: 'Schedule Builder' },
      { href: 'admin-team-roster.html',  icon: '\u{1F5C2}', label: 'Roster' },
      { href: 'admin-timesheets.html',   icon: '⏱',    label: 'Timesheets' },
      { href: 'admin-time-off.html',     icon: '\u{1F334}', label: 'Time-off' },
      { href: 'admin-staff.html',        icon: '\u{1FAAA}', label: 'Staff Roles' },
      { section: 'Outreach' },
      { href: 'admin-invite-friends.html', icon: '\u{1F4E8}', label: 'Invite Friends' },
      { href: 'contacts.html',           icon: '\u{1F4C7}', label: 'Contacts' },
      { section: 'Account' },
      { href: 'profile.html',            icon: '\u{1F464}', label: 'Profile' },
      { href: 'my-feedback.html',        icon: '\u{1F4DD}', label: 'My Feedback' }
    ]
  };

  function injectStyles() {
    if (document.getElementById('lymx-sidebar-styles')) return;
    var style = document.createElement('style');
    style.id = 'lymx-sidebar-styles';
    style.textContent =
      '.lymx-sb{position:fixed;left:14px;top:84px;width:232px;max-height:calc(100vh - 100px);overflow-y:auto;background:#fff;border:1px solid #e6e8ec;border-radius:12px;padding:12px 10px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;box-shadow:0 4px 14px rgba(14,17,22,.06);z-index:30}'
      + '.lymx-sb h3{font-size:11px;font-weight:800;color:#0a84ff;margin:6px 8px 4px;padding:0;text-transform:uppercase;letter-spacing:.08em}'
      + '.lymx-sb h3:first-child{margin-top:0}'
      + '.lymx-sb a, .lymx-sb button.lymx-sb-act{display:flex;align-items:center;gap:9px;padding:8px 11px;margin-bottom:2px;background:transparent;border:0;border-radius:7px;color:#1a1f27;text-decoration:none;cursor:pointer;font:600 13px/1.2 inherit;text-align:left;transition:background .12s,color .12s;width:100%}'
      + '.lymx-sb a:hover, .lymx-sb button.lymx-sb-act:hover{background:#eef4ff;color:#0a84ff}'
      + '.lymx-sb a.active{background:#0e1116;color:#fff}'
      + '.lymx-sb a.active:hover{background:#1a1f27;color:#fff}'
      + '.lymx-sb .lymx-sb-icon{font-size:14px;flex-shrink:0;width:18px;text-align:center}'
      + '.lymx-sb .who-mini{padding:8px 11px;margin-bottom:6px;font-size:11.5px;color:#5b6472;border-bottom:1px solid #f1f3f6}'
      + '.lymx-sb .who-mini b{display:block;color:#0e1116;font-size:13px;font-weight:700;margin-bottom:2px;word-break:break-all}'
      + '.lymx-sb .who-mini .role-tag{display:inline-block;background:#EEF6FF;color:#0a84ff;font-size:10px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;padding:2px 7px;border-radius:999px}'
      + '.lymx-sb .signout{color:#B91C1C}'
      + '.lymx-sb-pushed{padding-left:260px}'
      + '@media(max-width:1100px){.lymx-sb{display:none}.lymx-sb-pushed{padding-left:0}}';
    document.head.appendChild(style);
  }

  function buildSidebar(role) {
    var items = MENUS[role] || MENUS.customer;
    var aside = document.createElement('aside');
    aside.className = 'lymx-sb';
    aside.setAttribute('aria-label', role + ' navigation');
    var here = (location.pathname.split('/').pop() || '').toLowerCase();
    var html = '';

    var payload = decodeJwt(readStoredToken());
    var email = (payload && payload.email) || '';
    if (email) {
      var safe = email.replace(/[<>]/g, '');
      html += '<div class="who-mini"><b>' + safe + '</b><span class="role-tag">' + role + '</span></div>';
    }

    // i18n key maps: label/section text → translation key (so the i18n engine can swap them)
    var SECTION_KEY = {
      'Customer':'sidebar.section.customer','Business':'sidebar.section.business','Partner':'sidebar.section.partner',
      'Admin':'sidebar.section.admin','Account':'sidebar.section.account','Network':'sidebar.section.network',
      'Operations':'sidebar.section.operations','Team':'sidebar.section.team','Outreach':'sidebar.section.outreach',
      'My Business':'sidebar.section.my_business'
    };
    var LABEL_KEY = {
      'Dashboard':'sidebar.dashboard','My LYMX Wallet':'sidebar.wallet','Send LYMX':'sidebar.send_lymx',
      'Browse Businesses':'sidebar.browse_businesses','Refer Friends':'sidebar.refer_friends',
      'My Reviews':'sidebar.my_reviews','Saved Places':'sidebar.saved_places','Donate LYMX':'sidebar.donate_lymx',
      'Messages':'sidebar.messages','Profile':'sidebar.profile','Contacts':'sidebar.contacts',
      'My Feedback':'sidebar.my_feedback','Analytics':'sidebar.analytics','My Customers':'sidebar.my_customers',
      'Staff':'sidebar.staff','Promo Planner':'sidebar.promo_planner','Cashflow':'sidebar.cashflow',
      'Payouts (Stripe)':'sidebar.payouts_stripe','POS / Integrations':'sidebar.integrations',
      'My Tree':'sidebar.my_tree','Leaderboard':'sidebar.leaderboard','Payouts':'sidebar.partner_payouts',
      'My Prospects':'sidebar.my_prospects','Invite Friends':'sidebar.invite_friends',
      'Tech Support':'sidebar.tech_support','Conversations':'sidebar.conversations','Tickets':'sidebar.tickets',
      'Team Chat':'sidebar.team_chat','Broadcast':'sidebar.broadcast','Compose Email':'sidebar.compose_email',
      'Email Events':'sidebar.email_events','SMS':'sidebar.sms','Businesses':'sidebar.businesses',
      'Biz Applications':'sidebar.biz_applications','Customers':'sidebar.customers','Promos':'sidebar.promos',
      'Approvals':'sidebar.approvals','Review Verification':'sidebar.review_verification',
      'Onboarding Calendar':'sidebar.onboarding_calendar','Verifications':'sidebar.verifications',
      'Roster':'sidebar.roster','Timesheets':'sidebar.timesheets','Time-off':'sidebar.time_off',
      'Staff Roles':'sidebar.staff_roles'
    };

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.section) {
        var sKey = SECTION_KEY[it.section] || '';
        html += '<h3' + (sKey ? ' data-i18n="' + sKey + '"' : '') + '>' + it.section + '</h3>';
      } else {
        var active = (it.href || '').toLowerCase() === here ? ' active' : '';
        var lKey = LABEL_KEY[it.label] || '';
        html += '<a class="' + active.trim() + '" href="' + it.href + '">'
              + '<span class="lymx-sb-icon">' + (it.icon || '') + '</span>'
              + '<span' + (lKey ? ' data-i18n="' + lKey + '"' : '') + '>' + it.label + '</span></a>';
      }
    }
    html += '<button class="lymx-sb-act signout" id="lymx-sb-signout" type="button">'
          + '<span class="lymx-sb-icon">\u{1F6AA}</span><span data-i18n="nav.sign_out">Sign out</span></button>';

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
  }

  window.LymxSidebar = {
    refresh: function () {
      var existing = document.querySelector('.lymx-sb');
      if (existing) existing.remove();
      document.body.classList.remove('lymx-sb-pushed');
      mount();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
