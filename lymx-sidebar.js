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

  // 2026-05-24 — true root-cause fix for Cluster A bugs (8+ tickets):
  //   "Profile / Calendar / Leads / Contacts / Messages / Feedback pages
  //    change sidebar role from Partner to Customer".
  //
  // Previous behaviour was 100% URL-path-based: pages that don't contain
  // "partner-" / "rep-" / "biz-" / "customer-" / "admin-" in their path
  // (e.g. profile.html, team-calendar.html, leads.html, contacts.html,
  // my-conversations.html, my-feedback.html, my-bookings.html,
  // my-reviews.html, my-saved-places.html, prospects.html, refer.html)
  // defaulted to 'customer' — so a logged-in partner saw the customer
  // sidebar on every shared page no matter how they got there.
  //
  // Root cause: role detection should NOT depend on URL paths. The user's
  // actual roles come from the database (staff_roles, partners, businesses,
  // customers). Path-based detection is fine for a fast first paint, but
  // the DB-resolved role is the source of truth and persists across tabs
  // and reloads.
  //
  // Resolution order (highest privilege first):
  //   1. body[data-lymx-role] override (per-page intentional)
  //   2. URL path heuristic (used as a "mode toggle": on customer-* pages
  //      a multi-role user sees customer sidebar; on rep-* they see partner)
  //   3. JWT-cached DB role (sessionStorage, set by the async resolver)
  //   4. lymx_active_role legacy cache (last role-specific page in tab)
  //   5. body[data-role] legacy attr / 'customer' final fallback
  //
  // The async confirmRoleFromDb() in mount() updates the lymx_db_role
  // cache on every mount and refreshes the sidebar if the first paint
  // was wrong.
  function _stashActiveRole(role) {
    try { sessionStorage.setItem('lymx_active_role', role); } catch (e) { console.warn("[lymx-sidebar.js:102] web-storage op failed (private mode? quota?):", e); }
  }
  function _readActiveRole() {
    try { return sessionStorage.getItem('lymx_active_role'); } catch (e) { return null; }
  }
  function _stashDbRole(role) {
    try { sessionStorage.setItem('lymx_db_role', role); } catch (e) { console.warn("[lymx-sidebar.js:108] web-storage op failed (private mode? quota?):", e); }
  }
  function _readDbRole() {
    try { return sessionStorage.getItem('lymx_db_role'); } catch (e) { return null; }
  }

  // Path heuristic — returns role only if path disambiguates, else null.
  function _rolePathOnly() {
    var path = (location.pathname || '').toLowerCase();
    if (/\/admin-/.test(path) || /admin-dashboard\.html$/.test(path)) return 'admin';
    if (/\/biz-/.test(path) || /biz-dashboard\.html$/.test(path)) return 'business';
    if (/\/(rep-|partner-)/.test(path) || /rep-dashboard\.html$/.test(path)) return 'partner';
    if (/customer-/.test(path) || /\/wallet\.html$/.test(path)) return 'customer';
    return null;
  }

  function detectRole() {
    var override = document.body && document.body.getAttribute('data-lymx-role');
    if (override) { _stashActiveRole(override); return override; }
    var tok = readStoredToken();
    var payload = decodeJwt(tok);
    // 2026-05-25 #9574bf1a — removed hardcoded Kenny UUID admin shortcut
    // (ARCHITECTURE-RULES Rule 0: no per-tester UUID special cases). The
    // _readDbRole() cache below + the async confirmRoleFromDb() resolve every
    // admin user the same way without singling Kenny out. First paint may show
    // 'customer' for a few hundred ms on cold sessions; async refresh fixes it.
    // Unambiguous path wins (mode toggle for multi-role users).
    var pathRole = _rolePathOnly();
    if (pathRole) { _stashActiveRole(pathRole); return pathRole; }
    // Shared page: prefer DB-cached role, then legacy active-mode cache.
    var dbCached = _readDbRole();
    if (dbCached) return dbCached;
    var cached = _readActiveRole();
    if (cached) return cached;
    return (document.body && document.body.getAttribute('data-role')) || 'customer';
  }

  // Async — confirm role from the DB. Highest-privilege wins:
  // admin > partner > business > customer. Updates the lymx_db_role
  // cache and triggers a sidebar refresh if the first paint disagreed.
  async function resolveRoleFromDb() {
    try {
      var cfg = window.LYMX_CONFIG;
      var tok = readStoredToken();
      if (!cfg || !tok) return null;
      var payload = decodeJwt(tok);
      var uid = payload && payload.sub;
      if (!uid) return null;

      try {
        // 2026-05-26 root-cause fix for Rachel's blink-loop tickets
        // (#b4304da7 customer-dashboard blink, #d1c9cb75 menu items blink,
        // #f35538b9 clock icon blink, #a088daa2 "page is for Admin").
        // Previously this query selected `role` only and ANY staff_roles row
        // painted the admin sidebar via `if (sroles.length) return 'admin'`.
        // That band-aid disagreed with lymx-nav.js:474's correct predicate
        // (role==='admin' || is_cfo || is_hr), so non-admin staff like Rachel
        // (role='marketing') got the admin menu, clicked an admin-* link,
        // got bounced by enforceAdminGuard, landed back on a page whose
        // sidebar still showed admin links - the blink loop.
        // Fix: select the same fields enforceAdminGuard reads and use the
        // SAME predicate. Non-admin staff fall through to the partners/
        // businesses/customer resolver and get the menu matching their
        // actual product role.
        var sr = await fetch(cfg.SUPABASE_URL + '/rest/v1/staff_roles?user_id=eq.' + uid + '&select=role,is_cfo,is_hr&limit=5', {
          headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + tok }
        });
        if (sr.ok) {
          var sroles = await sr.json();
          if (Array.isArray(sroles) && sroles.length) {
            var hasAdminRow = sroles.some(function (s) {
              return s.role === 'admin' || s.is_cfo === true || s.is_hr === true;
            });
            if (hasAdminRow) return 'admin';
            // else: staff but not admin-tier; fall through so their sidebar
            // matches their actual product role (customer / partner / business).
          }
        }
      } catch (e) { console.warn('[sidebar] staff_roles probe', e); }

      try {
        var pr = await fetch(cfg.SUPABASE_URL + '/rest/v1/partners?user_id=eq.' + uid + '&select=id&limit=1', {
          headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + tok }
        });
        if (pr.ok) {
          var prows = await pr.json();
          if (Array.isArray(prows) && prows.length) return 'partner';
        }
      } catch (e) { console.warn('[sidebar] partners probe', e); }

      try {
        var br = await fetch(cfg.SUPABASE_URL + '/rest/v1/businesses?owner_user_id=eq.' + uid + '&select=id&limit=1', {
          headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + tok }
        });
        if (br.ok) {
          var brows = await br.json();
          if (Array.isArray(brows) && brows.length) return 'business';
        }
      } catch (e) { console.warn('[sidebar] businesses probe', e); }

      return 'customer';
    } catch (e) {
      console.warn('[sidebar] resolveRoleFromDb', e);
      return null;
    }
  }

  var MENUS = {
    customer: [
      { section: 'Wallet' },
      { href: 'customer-dashboard.html', icon: '\u{1F3E0}', label: 'Dashboard' },
      { href: 'customer-wallet.html',    icon: '\u{1F4B0}', label: 'My LYMX Wallet' },
      { href: 'browse.html',             icon: '\u{1F50D}', label: 'Browse Businesses' },
      { section: 'Network' },
      { href: 'refer.html',              icon: '\u{1F4E8}', label: 'Refer Friends' },
      { href: 'share-hub.html',          icon: '\u{1F4E3}', label: 'Share hub' },
      { href: 'my-bookings.html',        icon: '\u{1F4C5}', label: 'My bookings' },
      { href: 'my-reviews.html',         icon: '⭐',    label: 'My Reviews' },
      { href: 'my-saved-places.html',   icon: '\u{1F4CC}', label: 'Saved Places' },
      { href: 'customer-charity.html',   icon: '\u{1F49D}', label: 'Donate LYMX' },
      { section: 'Help' },
      { href: 'playbooks.html',          icon: '\u{1F4D6}', label: 'Playbooks' },
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
      { href: 'share-hub.html',          icon: '\u{1F4E3}', label: 'Share hub' },
      { href: 'biz-cashflow.html',       icon: '\u{1F4B5}', label: 'Cashflow' },
      { href: 'biz-payouts.html',        icon: '\u{1F3E6}', label: 'Payouts (Stripe)' },
      { href: 'biz-pos-comparison.html', icon: '\u{1F50C}', label: 'POS / Integrations' },
      { href: 'my-bookings.html',        icon: '\u{1F4C5}', label: 'My bookings' },
      { section: 'Help' },
      { href: 'playbooks.html',          icon: '\u{1F4D6}', label: 'Playbooks' },
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
      // 2026-05-26 #7bfc73c8 (Rachel) — Comp Plan page now exists at /comp-plan.html.
      // Sidebar entry sits in the Partner section so partners can find it on every
      // page, not just from the share-hub "see comp plan" link that used to 404.
      { href: 'comp-plan.html',          icon: '\u{1F4B5}', label: 'Comp Plan' },
      { href: 'prospects.html',          icon: '\u{1F3AF}', label: 'My Prospects' },
      // 2026-05-25 #6df906ba — partners had no direct sidebar entry to the
      // Sales Toolkit (the page reachable from the "Open pitch toolkit" empty-
      // state button on rep-dashboard). Discoverability fix: one-click from any
      // page. Same destination, just no longer buried behind a conditional empty state.
      { href: 'partner-resources.html',  icon: '\u{1F4BC}', label: 'Sales Toolkit' },
      { href: 'team-calendar.html',      icon: '\u{1F4C5}', label: 'My Calendar' },
      { href: 'my-bookings.html',        icon: '\u{1F4DD}', label: 'My bookings' },
      // 2026-05-25 Cluster A — Dave (P-000100) filed 3 tickets that all reduce
      // to 'these pages exist but partners can't find them in the sidebar':
      //   - Notifications feature
      //   - My LYMX Wallet feature
      //   - My Reviews feature
      // Wiring them in directly here. Each page already supports the partner
      // role (no requireRole restrictions). Wallet links to customer-dashboard
      // because partners earn LYMX as customers do (separate from commissions),
      // and customer-dashboard renders the balance card from lymx_issuances
      // keyed on the user_id — which works for any role.
      { href: 'notifications.html',      icon: '\u{1F514}', label: 'Notifications' },
      { href: 'customer-dashboard.html#wallet', icon: '\u{1F4B0}', label: 'My LYMX Wallet' },
      { href: 'my-reviews.html',         icon: '\u2B50',    label: 'My Reviews' },
      { section: 'Help' },
      { href: 'playbooks.html',          icon: '\u{1F4D6}', label: 'Playbooks' },
      // 2026-05-20 #dd9468cc - Removed static Team section (Clock In, My Schedule,
      // My Time-off) from partner menu. These are STAFF-only pages and were
      // showing for every partner, causing 'This page isn't for you' rejections.
      // maybeInjectStaffSection() below auto-appends them ONLY for users who have
      // an hr_employees row (i.e. partners who are ALSO hired as staff).
      { section: 'Account' },
      { href: 'my-conversations.html',   icon: '\u{1F4EC}', label: 'Messages' },
      { href: 'profile.html',            icon: '\u{1F464}', label: 'Profile' },
      // 2026-05-22 #2547e13e — partners couldn't find a refer-a-friend page;
      // they had "Invite Friends" (bulk outreach) but no personal share link.
      // Added explicit "Refer a Friend" → refer.html mirroring the customer menu.
      { href: 'refer.html',              icon: '\u{1F381}', label: 'Refer a Friend' },
      { href: 'admin-invite-friends.html', icon: '\u{1F4E8}', label: 'Invite Friends' },
      { href: 'share-hub.html',            icon: '\u{1F4E3}', label: 'Share hub' },
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
      { href: 'admin-business-transfer.html', icon: '\u{1F504}', label: 'Transfer ownership' },
      { href: 'admin-customers.html',    icon: '\u{1F465}', label: 'Customers' },
      { href: 'admin-partners.html',     icon: '\u{1F91D}', label: 'Partners' },
      { href: 'admin-promos.html',       icon: '\u{1F381}', label: 'Promos' },
      { href: 'admin-approvals.html',    icon: '✅',    label: 'Approvals' },
      { href: 'admin-reviews.html',      icon: '⭐',    label: 'Review Verification' },
      { href: 'admin-onboarding-calendar.html', icon: '\u{1F4C5}', label: 'Onboarding Calendar' },
      { href: 'team-calendar.html',      icon: '\u{1F5D3}', label: 'My Calendar' },
      { href: 'admin-verifications.html', icon: '\u{1FAAA}', label: 'Verifications' },
      { href: 'admin-fraud-flags.html',  icon: '\u{1F6A8}', label: 'Fraud flags' },
      { section: 'Team' },
      { href: 'admin-staff.html',           icon: '\u{1FAAA}', label: 'Staff Roles' },
      { href: 'admin-personnel-records.html', icon: '\u{1F4C7}', label: 'Personnel Records' },
      { href: 'admin-schedule.html',        icon: '\u{1F4C5}', label: 'Schedule Builder' },
      { href: 'admin-schedule-requests.html', icon: '\u{1F4DD}', label: 'Schedule Weeks' },
      { href: 'admin-time-off.html',        icon: '\u{1F334}', label: 'Time-off' },
      { href: 'admin-team-roster.html',     icon: '\u{1F5C2}', label: 'Roster' },
      { section: 'HR & Payroll' },
      { href: 'admin-staff-locations.html',     icon: '\u{1F4CD}', label: 'Clock-in Locations' },
      { href: 'admin-clock-in-permissions.html', icon: '\u{1F510}', label: 'Clock-in Permissions' },
      { href: 'admin-clock-in-requests.html',    icon: '\u{1F4E5}', label: 'Pending Requests' },
      { href: 'admin-timesheets.html',           icon: '\u{23F1}',  label: 'Timesheets' },
      { href: 'admin-payroll-reconciliation.html', icon: '\u{1F4B0}', label: 'Payroll Run' },
      { href: 'admin-generate-offer.html',       icon: '\u{1F4E8}', label: 'Generate Offer' },
      { href: 'admin-counter-offer-queue.html',  icon: '\u{1F501}', label: 'Counter Offers' },
      { href: 'admin-bulk-policy-assign.html',   icon: '\u{1F4D1}', label: 'Bulk Policy Assign' },
      { href: 'admin-inventory.html',            icon: '\u{1F4E6}', label: 'Inventory' },
      { href: 'admin-outstanding-property.html', icon: '\u{1F6A9}', label: 'Outstanding Property' },
      { href: 'admin-send-hr-launch.html',       icon: '\u{1F44B}', label: 'Send Welcome Email' },
      { section: 'Outreach' },
      { href: 'admin-invite-friends.html', icon: '\u{1F4E8}', label: 'Invite Friends' },
      { href: 'contacts.html',           icon: '\u{1F4C7}', label: 'Contacts' },
      { section: 'Knowledge' },
      { href: 'playbooks.html',          icon: '\u{1F4D6}', label: 'Playbooks' },
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
      // Try to derive a sensible initial display name from JWT user_metadata so the
      // sidebar header reads as the account owner, not their email. loadPartnerCode
      // below overrides with the canonical display_name from partners/customers tables.
      var metaName = '';
      try {
        var meta = (payload && payload.user_metadata) || {};
        metaName = meta.full_name || meta.name || '';
      } catch (e) { console.warn('[sidebar] metadata read', e); }
      var initialName = metaName || safe.split('@')[0];
      // 2026-05-21 #b2458da0 - was showing email as the bold field. Now shows
      // display_name (or username portion as fallback). Email demoted to a small
      // muted line below. Partner code chip stays underneath as before.
      // 2026-05-24 T-DE7213 -- mini-avatar in sidebar header for a more
      // organized profile section. Avatar is painted async by
      // window.LYMX.paintAvatarOn (lymx-nav.js).
      var seedId = (payload && (payload.sub || payload.id)) || email || 'lymx';
      var initials2 = '';
      try {
        var nmSrc = (metaName || initialName || '').trim();
        if (nmSrc) {
          var ps = nmSrc.split(/[\\s.]+/).filter(Boolean);
          if (ps.length >= 2) initials2 = (ps[0][0] + ps[1][0]).toUpperCase();
          else if (ps.length === 1) initials2 = ps[0].slice(0,2).toUpperCase();
        }
        if (!initials2) initials2 = safe.charAt(0).toUpperCase() + (safe.split('@')[0].charAt(1) || '').toUpperCase();
      } catch (e) { initials2 = (safe[0] || 'L').toUpperCase(); }
      // Deterministic gradient from a stable palette indexed by seedId hash
      var palette2 = [['#0a84ff','#0050c7'],['#6366f1','#4338ca'],['#8b5cf6','#6d28d9'],['#ec4899','#be185d'],['#f59e0b','#b45309'],['#13a26b','#047857'],['#0891b2','#0e7490'],['#ef4444','#991b1b']];
      var hh = 0; for (var ii = 0; ii < seedId.length; ii++) hh = (hh * 31 + seedId.charCodeAt(ii)) | 0;
      var gp = palette2[Math.abs(hh) % palette2.length];
      var grad2 = 'linear-gradient(135deg,' + gp[0] + ',' + gp[1] + ')';
      html += '<div class="who-mini" id="lymxWhoMini" style="display:flex;align-items:flex-start;gap:10px">'
            + '<div id="lymxWhoMiniAvatar" style="width:38px;height:38px;border-radius:50%;background:' + grad2 + ';color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;flex-shrink:0;position:relative;overflow:hidden">' + initials2 + '</div>'
            + '<div style="min-width:0;flex:1">'
            + '<b id="lymxWhoMiniName" style="display:block;line-height:1.2">' + initialName + '</b>'
            // 2026-05-25 #9574bf1a / #729d977d — the role-tag should reflect the
            // user's HIGHEST account role (e.g. admin/partner), not the page-mode
            // role (which is just "which dashboard am I looking at"). Helen Chen
            // (admin + partner + customer) visited /customer-dashboard, saw the
            // tag say "Customer", and read it as "my account didn't upgrade".
            // Root cause: tag was hardcoded to the menu role. Fix: show the
            // highest of (menu role, cached DB role); add a small "viewing X mode"
            // sub-pill when the two differ so multi-role users can see both.
            + (function(){
                var menuMode = role;
                var accountRole = (function(){ try { return sessionStorage.getItem('lymx_db_role'); } catch(e) { return null; } })() || menuMode;
                var rnk = { admin: 4, partner: 3, business: 2, customer: 1 };
                var topRole = (rnk[accountRole] || 0) >= (rnk[menuMode] || 0) ? accountRole : menuMode;
                var tag = '<span class="role-tag" data-role-account="1" style="margin-top:3px;display:inline-block">' + topRole + '</span>';
                if (topRole !== menuMode) {
                  tag += '<span class="mode-tag" data-role-mode="1" style="margin-left:6px;background:#f3f4f6;color:#4b5563;font-size:9px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:2px 6px;border-radius:999px;display:inline-block">viewing ' + menuMode + ' mode</span>';
                }
                return tag;
              })()
            + '<div id="lymxWhoMiniCode" style="display:none;margin-top:6px;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#0050c7;cursor:pointer" title="Click to copy your referral code"></div>'
            + '</div>'
            + '</div>';
      // Paint photo over the initials when lymx-nav.js exposes the helper
      try {
        setTimeout(function(){
          var el = document.getElementById('lymxWhoMiniAvatar');
          if (!el) return;
          if (window.LYMX && window.LYMX.lookupAvatarUrl && window.LYMX.paintAvatarOn) {
            var uid = (payload && (payload.sub || payload.id));
            if (uid) window.LYMX.lookupAvatarUrl(uid).then(function(url){ if (url) window.LYMX.paintAvatarOn(el, url); });
          }
        }, 600);
      } catch (e) { console.warn('[sidebar] mini avatar paint', e); }
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
      'Browse Businesses':'sidebar.browse_businesses','Refer Friends':'sidebar.refer_friends','Share hub':'sidebar.share_hub',
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

  // 2026-05-20 #4aa8c795 — Some users are BOTH customer + staff (e.g. a
  // Customer who got hired by a Business as part-time staff). The role
  // detector is path-based: on customer-* pages it routes them to the
  // customer menu which has no Clock In. Fix: if the signed-in user has any
  // hr_employees row, append a "My Work" team section (Clock In + My
  // Schedule + My Time-off) regardless of the path-detected role.
  async function maybeInjectStaffSection(asideEl) {
    if (!asideEl) return;
    try {
      var cfg = window.LYMX_CONFIG;
      var tok = readStoredToken();
      if (!cfg || !tok) return;
      var payload = decodeJwt(tok);
      var uid = payload && payload.sub;
      if (!uid) return;
      var cacheKey = 'LYMX_is_staff_' + uid;
      var cached = null;
      try { cached = sessionStorage.getItem(cacheKey); } catch (e) { console.warn('[sidebar] sessionStorage read', e); }
      if (cached === 'no') return;
      if (cached !== 'yes') {
        // 2026-05-25 #e30cc86d #4aa8c795 — was querying public.hr_employees,
        // which doesn't exist (HR migration 055 named the table staff_profiles,
        // keyed on user_id). The 404 fell into the !r.ok branch, cached 'no',
        // and silently hid Clock In/My Schedule/My Time-off for every staff +
        // partner user. Fix: query the right table.
        // 2026-05-25 — Clock In is for on-payroll staff only (Kenny's rule:
        // all staff are partners, but partners are not auto-paid staff). The
        // gate must filter is_on_payroll=true so a partners-row alone doesn't
        // unlock Clock In. Helen (HR/CFO/Owner) gets it, Dave/Rachel (partners-
        // only) don't.
        var r = await fetch(cfg.SUPABASE_URL + '/rest/v1/staff_profiles?user_id=eq.' + uid + '&is_on_payroll=eq.true&select=user_id&limit=1', {
          headers: { 'apikey': cfg.SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + tok }
        });
        if (!r.ok) { try { sessionStorage.setItem(cacheKey, 'no'); } catch (e) { console.warn('[sidebar] sessionStorage write', e); } return; }
        var rows = await r.json();
        var ans = (rows && rows.length) ? 'yes' : 'no';
        try { sessionStorage.setItem(cacheKey, ans); } catch (e) { console.warn('[sidebar] sessionStorage write', e); }
        if (ans === 'no') return;
      }
      if (asideEl.querySelector('a[href="staff-clock-in.html"]')) return;
      var here = (location.pathname.split('/').pop() || '').toLowerCase();
      function aHTML(href, icon, label) {
        var active = href.toLowerCase() === here ? ' active' : '';
        return '<a class="' + active.trim() + '" href="' + href + '"><span class="lymx-sb-icon">' + icon + '</span><span>' + label + '</span></a>';
      }
      var insertHTML =
        '<h3>My Work</h3>' +
        aHTML('staff-clock-in.html', '\u{23F1}', 'Clock In') +
        aHTML('my-schedule.html', '\u{1F4C5}', 'My Schedule') +
        aHTML('my-time-off.html', '\u{1F334}', 'My Time-off') +
        aHTML('my-personnel-file.html', '\u{1F4C7}', 'My File') +
        aHTML('my-clock-in-anchor.html', '\u{1F4CD}', 'My Locations') +
        aHTML('staff-clock-in-anchor.html', '\u{1F3E0}', 'Remote Address') +
        aHTML('staff-clock-in-permission-request.html', '\u{1F4E5}', 'Single-day Exception');
      var signout = asideEl.querySelector('#lymx-sb-signout');
      if (signout) {
        var wrap = document.createElement('div');
        wrap.innerHTML = insertHTML;
        while (wrap.firstChild) asideEl.insertBefore(wrap.firstChild, signout);
      } else {
        asideEl.insertAdjacentHTML('beforeend', insertHTML);
      }
    } catch (e) { console.warn('[sidebar] staff-section inject failed', e); }
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

    // 2026-05-24 — async DB role confirmation. If the first paint chose the
    // wrong role (e.g. landed on /profile.html with empty sessionStorage and
    // we guessed 'customer' but the user is a partner), this refreshes the
    // sidebar with the correct role and stashes the answer for instant
    // correct first paint on subsequent navigations within the session.
    (async function confirmRoleFromDb() {
      try {
        var dbRole = await resolveRoleFromDb();
        if (!dbRole) return;
        _stashDbRole(dbRole);
        var rnk = { admin: 4, partner: 3, business: 2, customer: 1 };
        // 2026-05-25 #9574bf1a / #729d977d — even on path-disambiguated pages,
        // upgrade the ACCOUNT role-tag in place when the DB resolves a higher
        // role than what we initially painted. We leave the MENU alone (the user
        // is intentionally in customer-view mode), but the tag must show their
        // true account level so they don't think their upgrade failed.
        try {
          var tagEl = document.querySelector('.lymx-sb .role-tag[data-role-account="1"]');
          if (tagEl) {
            var currentDisplayed = (tagEl.textContent || '').trim().toLowerCase();
            if ((rnk[dbRole] || 0) > (rnk[currentDisplayed] || 0)) {
              tagEl.textContent = dbRole;
              var parentMini = tagEl.parentElement;
              if (parentMini) {
                var existingModePill = parentMini.querySelector('.mode-tag[data-role-mode="1"]');
                if (existingModePill) existingModePill.remove();
                if (dbRole !== role) {
                  var modePill = document.createElement('span');
                  modePill.className = 'mode-tag';
                  modePill.setAttribute('data-role-mode', '1');
                  modePill.setAttribute('style', 'margin-left:6px;background:#f3f4f6;color:#4b5563;font-size:9px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:2px 6px;border-radius:999px;display:inline-block');
                  modePill.textContent = 'viewing ' + role + ' mode';
                  tagEl.insertAdjacentElement('afterend', modePill);
                }
              }
            }
          }
        } catch (e) { console.warn('[sidebar] role-tag in-place update', e); }
        var pathRole = _rolePathOnly();
        if (pathRole) return;
        if (dbRole !== role && window.LymxSidebar && typeof window.LymxSidebar.refresh === 'function') {
          window.LymxSidebar.refresh();
        }
      } catch (e) { console.warn('[sidebar] confirmRoleFromDb', e); }
    })();

    // 2026-05-20 #4aa8c795 - async append "My Work" section for staff users.
    maybeInjectStaffSection(sidebar);
    // 2026-05-20 #631935ae - hydrate the partner_code chip in who-mini header.
    (async function loadPartnerCode() {
      try {
        var cfg = window.LYMX_CONFIG;
        var tok = readStoredToken();
        if (!cfg || !tok) return;
        var payload = decodeJwt(tok);
        var uid = payload && payload.sub; if (!uid) return;
        var cacheKey = 'LYMX_partner_code_' + uid;
        var cached = null;
        try { cached = sessionStorage.getItem(cacheKey); } catch (e) { console.warn('[sidebar] partner_code cache read', e); }
        if (cached === '__none__') return;
        var code = cached;
        if (!code) {
          var r = await fetch(cfg.SUPABASE_URL + '/rest/v1/partners?user_id=eq.' + uid + '&select=partner_code&limit=1', {
            headers: { 'apikey': cfg.SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + tok }
          });
          if (!r.ok) { try { sessionStorage.setItem(cacheKey, '__none__'); } catch (e) { console.warn("[lymx-sidebar.js:648] web-storage op failed (private mode? quota?):", e); } return; }
          var rows = await r.json();
          code = (rows && rows[0] && rows[0].partner_code) || null;
          if (!code) { try { sessionStorage.setItem(cacheKey, '__none__'); } catch (e) { console.warn("[lymx-sidebar.js:651] web-storage op failed (private mode? quota?):", e); } return; }
          try { sessionStorage.setItem(cacheKey, code); } catch (e) { console.warn("[lymx-sidebar.js:652] web-storage op failed (private mode? quota?):", e); }
        }
        // 2026-05-21 #b2458da0 - also paint the canonical display_name in the bold slot
        try {
          var nameEl = document.getElementById('lymxWhoMiniName');
          if (nameEl) {
            var pr = await fetch(cfg.SUPABASE_URL + '/rest/v1/partners?user_id=eq.' + uid + '&select=display_name,legal_name&limit=1', { headers: { 'apikey': cfg.SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + tok } });
            if (pr.ok) {
              var prows = await pr.json();
              var nm = (prows && prows[0]) ? (prows[0].display_name || prows[0].legal_name) : null;
              if (!nm) {
                var cr = await fetch(cfg.SUPABASE_URL + '/rest/v1/customers?user_id=eq.' + uid + '&select=display_name&limit=1', { headers: { 'apikey': cfg.SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + tok } });
                if (cr.ok) {
                  var crows = await cr.json();
                  nm = (crows && crows[0] && crows[0].display_name) || null;
                }
              }
              if (nm) nameEl.textContent = nm;
            }
          }
        } catch (e) { console.warn('[sidebar] display_name load', e); }
        var el = document.getElementById('lymxWhoMiniCode');
        if (!el) return;
        el.textContent = code + ' • copy';
        el.style.display = 'block';
        el.addEventListener('click', function () {
          try {
            navigator.clipboard.writeText(code);
            var orig = el.textContent;
            el.textContent = 'copied!';
            setTimeout(function () { el.textContent = orig; }, 1200);
          } catch (e) { console.warn('[sidebar] copy failed', e); }
        });
      } catch (e) { console.warn('[sidebar] partner_code loader', e); }
    })();
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
