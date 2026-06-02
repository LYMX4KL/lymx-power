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
    try { sessionStorage.setItem('lymx_active_role', role); } catch (e) { console.warn('[lymx-sidebar] active-role write', e); }
  }
  function _readActiveRole() {
    try { return sessionStorage.getItem('lymx_active_role'); } catch (e) { return null; }
  }
  function _stashDbRole(role) {
    try { sessionStorage.setItem('lymx_db_role', role); } catch (e) { console.warn('[lymx-sidebar] db-role write', e); }
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
    if (pathRole) {
      // 2026-05-30 — FAIL-CLOSED ADMIN MENU (ARCHITECTURE-RULES Rule 1).
      // The admin menu is a privilege, not a view-mode a non-admin can toggle
      // into by visiting an /admin-* URL. The old behaviour painted the full
      // admin menu from the URL path alone, so any non-admin who reached an
      // admin page saw all ~30 admin links and clicked through them — every
      // click then bounced via am_i_admin()=false. That was the root cause of
      // the Cluster-1 "loads 1-2s then bounces" tickets (e.g. P-000103, the
      // marketing/partner QA account that is NOT role='admin'). Only honour an
      // 'admin' path when the DB-confirmed role cache actually says admin; for a
      // real admin whose cache isn't warm yet, confirmRoleFromDb() below upgrades
      // and refreshes the menu. Non-admin (partner/business/customer) path roles
      // are unchanged — they remain a legitimate mode toggle.
      if (pathRole === 'admin' && _readDbRole() !== 'admin') {
        // fall through to the user's real cached role below — never paint admin.
      } else {
        _stashActiveRole(pathRole);
        return pathRole;
      }
    }
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
        var sr = await fetch(cfg.SUPABASE_URL + '/rest/v1/staff_roles?user_id=eq.' + uid + '&select=role&limit=5', {
          headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + tok }
        });
        if (sr.ok) {
          var sroles = await sr.json();
          // 2026-05-29 — only role='admin' grants the admin menu, matching the
          // server-side am_i_admin() (role='admin' only) and lymx-role-gate.js.
          // Previously ANY staff_roles row (marketing/support/hr/etc.) returned
          // 'admin', so non-admin staff saw the full admin menu but every admin
          // page bounced them via am_i_admin()=false — the root cause of the
          // Cluster A "loads 1-2s then redirects to dashboard" tickets.
          if (Array.isArray(sroles) && sroles.some(function (r) { return r && r.role === 'admin'; })) return 'admin';
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
      { section: 'Account' },
      { href: 'my-conversations.html',   icon: '\u{1F4EC}', label: 'Messages' },
      { href: 'notifications.html',     icon: '\u{1F514}', label: 'Notifications' },
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
      { section: 'Account' },
      { href: 'my-conversations.html',   icon: '\u{1F4EC}', label: 'Messages' },
      { href: 'notifications.html',     icon: '\u{1F514}', label: 'Notifications' },
      { href: 'profile.html',            icon: '\u{1F464}', label: 'Profile' },
      { href: 'contacts.html',           icon: '\u{1F4C7}', label: 'Contacts' },
      { href: 'my-feedback.html',        icon: '\u{1F4DD}', label: 'My Feedback' }
    ],
    partner: [
      { section: 'Partner' },
      { href: 'rep-dashboard.html',      icon: '\u{1F4CA}', label: 'Dashboard' },
      { href: 'partner-tree.html',       icon: '\u{1F333}', label: 'My Tree' },
      { href: 'partner-my-downlines.html', icon: '\u{1F465}', label: 'My Downlines' },
      { href: 'partner-referred-businesses.html', icon: '\u{1F3EA}', label: 'Referred Businesses' },
      { href: 'partner-recruit-links.html', icon: '\u{1F517}', label: 'Recruitment Links' },
      { href: 'partner-activity.html',    icon: '\u{1F4DC}', label: 'Activity History' },
      { href: 'partner-leaderboard.html', icon: '\u{1F3C6}', label: 'Leaderboard' },
      { href: 'partner-payouts.html',    icon: '\u{1F4B8}', label: 'Payouts' },
      { href: 'income-statement.html',   icon: '\u{1F9FE}', label: 'Income Statement' },
      { href: 'comp-plan.html',          icon: '\u{1F4B5}', label: 'Comp Plan' },
      { href: 'prospects.html',          icon: '\u{1F3AF}', label: 'My Prospects' },
      // 2026-05-25 #6df906ba — partners had no direct sidebar entry to the
      // Sales Toolkit (the page reachable from the "Open pitch toolkit" empty-
      // state button on rep-dashboard). Discoverability fix: one-click from any
      // page. Same destination, just no longer buried behind a conditional empty state.
      { href: 'partner-resources.html',  icon: '\u{1F4BC}', label: 'Sales Toolkit' },
      { href: 'team-calendar.html',      icon: '\u{1F4C5}', label: 'My Calendar' },
      { href: 'my-bookings.html',        icon: '\u{1F4DD}', label: 'My bookings' },
      // 2026-05-20 #dd9468cc - Removed static Team section (Clock In, My Schedule,
      // My Time-off) from partner menu. These are STAFF-only pages and were
      // showing for every partner, causing 'This page isn't for you' rejections.
      // maybeInjectStaffSection() below auto-appends them ONLY for users who have
      // an hr_employees row (i.e. partners who are ALSO hired as staff).
      { section: 'Account' },
      { href: 'my-conversations.html',   icon: '\u{1F4EC}', label: 'Messages' },
      { href: 'notifications.html',     icon: '\u{1F514}', label: 'Notifications' },
      { href: 'profile.html',            icon: '\u{1F464}', label: 'Profile' },
      // 2026-05-22 #2547e13e — partners couldn't find a refer-a-friend page;
      // they had "Invite Friends" (bulk outreach) but no personal share link.
      // Added explicit "Refer a Friend" → refer.html mirroring the customer menu.
      { href: 'refer.html',              icon: '\u{1F381}', label: 'Refer a Friend' },
      // 2026-05-28 #fe0fded7 — REMOVED partner "Invite Friends" entry. It pointed at
      // admin-invite-friends.html (admin-only), whose role guard bounced every partner
      // back to rep-dashboard. Dave's exact symptom: "clicking Invite Friends redirects
      // to Partner Dashboard." Root-cause: partners get the personal share link via
      // "Refer a Friend" and the bulk share via "Share hub" below; an admin-only
      // bulk-outreach tool shouldn't live in the partner menu at all.
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
      { href: 'admin-provisioned-emails.html', icon: '\u{1F4E7}', label: 'Company Emails' },
      { href: 'admin-commission-config.html', icon: '\u{2699}\uFE0F', label: 'Commission Config' },
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
      { href: 'admin-timesheet-import.html',     icon: '\u{1F4E5}', label: 'Import Timesheet (Excel)' },
      { href: 'admin-jobs.html',                  icon: '\u{1F4BC}', label: 'Jobs / Careers' },
      { href: 'admin-benefits-policy.html',      icon: '\u{1FA7A}', label: 'Benefits Policy' },
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
      { href: 'admin-playbooks.html',    icon: '\u{1F4D6}', label: 'Playbooks' },
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
      + '.lymx-sb-grp-h{display:flex;align-items:center;justify-content:space-between;width:100%;background:transparent;border:0;cursor:pointer;padding:7px 10px;margin-top:4px;font:inherit;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;border-radius:8px}'
      + '.lymx-sb-grp-h:hover{background:#f6f7f9}'
      + '.lymx-sb-chev{transition:transform .15s ease;font-size:15px;color:#9aa3b0}'
      + '.lymx-sb-grp.open > .lymx-sb-grp-h .lymx-sb-chev{transform:rotate(90deg)}'
      + '.lymx-sb-grp-body{display:none}'
      + '.lymx-sb-grp.open > .lymx-sb-grp-body{display:block}'
      + '.lymx-sb-shared-h{margin-top:10px;border-top:1px solid #eef0f3;padding-top:10px}'
      + '@media(max-width:1100px){.lymx-sb{display:none}.lymx-sb-pushed{padding-left:0}}';
    document.head.appendChild(style);
  }

  // 2026-06-01 (Kenny) — persist which sidebar groups are open across page loads
  // so navigating doesn't collapse the user's expanded sections (sidebar got long;
  // losing open state forced re-hunting). Session-scoped.
  function _readOpenGrps() { try { return JSON.parse(sessionStorage.getItem('lymx_sb_open_grps') || '[]') || []; } catch (e) { return []; } }
  function _saveOpenGrps(arr) { try { sessionStorage.setItem('lymx_sb_open_grps', JSON.stringify(arr)); } catch (e) {} }

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
                return tag; // 2026-05-31 — no "viewing X mode" pill; sidebar shows all entitled groups
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
      'Dashboard':'sidebar.dashboard','My LYMX Wallet':'sidebar.wallet',
      'Browse Businesses':'sidebar.browse_businesses','Refer Friends':'sidebar.refer_friends','Share hub':'sidebar.share_hub',
      'My Reviews':'sidebar.my_reviews','Saved Places':'sidebar.saved_places',
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

    // 2026-05-31 — collapsible role GROUPS replace page-mode switching. Show every
    // section the user is entitled to (ceiling = max(detected role, cached DB role));
    // each group collapses/expands; the current page's group is expanded by default;
    // shared account links render once at the bottom so they don't repeat per group.
    var _RNK = { admin:4, partner:3, business:2, customer:1 };
    var _dbCeil = (function(){ try { return sessionStorage.getItem('lymx_db_role'); } catch (e) { return null; } })();
    var ceil = (_RNK[_dbCeil]||0) > (_RNK[role]||0) ? _dbCeil : role;
    var groupOrder = ceil === 'admin' ? ['admin','partner','business','customer']
                   : ceil === 'partner' ? ['partner','customer']
                   : ceil === 'business' ? ['business','customer']
                   : ['customer'];
    var GROUP_LABEL = { admin:'Admin', partner:'Partner', business:'Business', customer:'Customer' };
    var SHARED = ['profile.html','my-conversations.html','notifications.html','my-feedback.html'];
    function _linkHtml(it) {
      var a = (it.href || '').toLowerCase() === here ? ' active' : '';
      var lk = LABEL_KEY[it.label] || '';
      return '<a class="' + a.trim() + '" href="' + it.href + '">'
           + '<span class="lymx-sb-icon">' + (it.icon || '') + '</span>'
           + '<span' + (lk ? ' data-i18n="' + lk + '"' : '') + '>' + it.label + '</span></a>';
    }
    var openGroup = null;
    for (var gi = 0; gi < groupOrder.length && !openGroup; gi++) {
      var gm = MENUS[groupOrder[gi]] || [];
      for (var gj = 0; gj < gm.length; gj++) {
        if (gm[gj].href && gm[gj].href.toLowerCase() === here) { openGroup = groupOrder[gi]; break; }
      }
    }
    if (!openGroup) openGroup = groupOrder[0];
    var _savedOpen = _readOpenGrps();
    for (var gx = 0; gx < groupOrder.length; gx++) {
      var g = groupOrder[gx];
      var menu = MENUS[g] || [];
      var links = menu.filter(function (it) { return it.href && SHARED.indexOf(it.href.toLowerCase()) === -1; });
      if (!links.length) continue;
      html += '<div class="lymx-sb-grp' + ((g === openGroup || _savedOpen.indexOf(g) > -1) ? ' open' : '') + '" data-grp="' + g + '">'
            + '<button type="button" class="lymx-sb-grp-h"><span>' + (GROUP_LABEL[g] || g) + '</span><span class="lymx-sb-chev">\u203A</span></button>'
            + '<div class="lymx-sb-grp-body">';
      for (var lx = 0; lx < links.length; lx++) html += _linkHtml(links[lx]);
      html += '</div></div>';
    }
    var sharedHtml = '';
    for (var sx = 0; sx < SHARED.length; sx++) {
      var found = null;
      for (var sg = 0; sg < groupOrder.length && !found; sg++) {
        var sm = MENUS[groupOrder[sg]] || [];
        for (var sm2 = 0; sm2 < sm.length; sm2++) { if (sm[sm2].href && sm[sm2].href.toLowerCase() === SHARED[sx]) { found = sm[sm2]; break; } }
      }
      if (found) sharedHtml += _linkHtml(found);
    }
    if (sharedHtml) html += '<h3 class="lymx-sb-shared-h">Account</h3>' + sharedHtml;
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

  // 2026-05-30 - append an "HR Admin" section for NON-admin users who have been
  // granted the hr_admin permission via Manage Permissions (e.g. Rachel, who
  // onboards/tests the HR module). True admins already see HR inside the full
  // admin menu, so skip them to avoid duplicate links. Mirrors
  // maybeInjectStaffSection: positive has_permission('hr_admin') check, cached.
  async function maybeInjectGrantedAdminSection(asideEl) {
    // 2026-05-30 (S1c-nav) - permission-driven admin nav. For NON-admin users,
    // render the admin menu items they are actually GRANTED (list_my_permissions:
    // admin shortcut -> explicit grant -> role default). HR pages share the single
    // hr_admin key, so a derived 'admin_<slug>' not present in the perms map means
    // it is an HR page -> fall back to 'hr_admin'. True admins already get the full
    // admin menu from buildSidebar and are skipped. Supersedes the HR-only injection.
    if (!asideEl) return;
    try {
      if (_readDbRole() === 'admin') return;
      if (asideEl.getAttribute('data-granted-admin') === '1') return;
      var cfg = window.LYMX_CONFIG;
      var tok = readStoredToken();
      if (!cfg || !tok) return;
      var r = await fetch(cfg.SUPABASE_URL + '/rest/v1/rpc/list_my_permissions', {
        method: 'POST',
        headers: { 'apikey': cfg.SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (!r.ok) return;
      var perms = await r.json();
      if (!perms || typeof perms !== 'object') return;
      function keyForHref(href) {
        var slug = String(href).replace(/^\//, '').replace(/\.html$/, '');
        var k = 'admin_' + slug.replace(/^admin-/, '').replace(/-/g, '_');
        return Object.prototype.hasOwnProperty.call(perms, k) ? k : 'hr_admin';
      }
      var here = (location.pathname.split('/').pop() || '').toLowerCase();
      function aHTML(href, icon, label) {
        var active = href.toLowerCase() === here ? ' active' : '';
        return '<a class="' + active.trim() + '" href="' + href + '"><span class="lymx-sb-icon">' + icon + '</span><span>' + label + '</span></a>';
      }
      var adminItems = MENUS.admin || [];
      var html = '';
      var pendingSection = null, sectionOpen = false, anyShown = false;
      adminItems.forEach(function (it) {
        if (it.section) { pendingSection = it.section; sectionOpen = false; return; }
        if (!it.href) return;
        var key = keyForHref(it.href);
        if (perms[key] === true) {
          if (pendingSection && !sectionOpen) { html += '<h3>' + pendingSection + '</h3>'; sectionOpen = true; }
          html += aHTML(it.href, it.icon || '', it.label || it.href);
          anyShown = true;
        }
      });
      if (!anyShown) return;
      asideEl.setAttribute('data-granted-admin', '1');
      var signout = asideEl.querySelector('#lymx-sb-signout');
      if (signout) {
        var wrap = document.createElement('div');
        wrap.innerHTML = html;
        while (wrap.firstChild) asideEl.insertBefore(wrap.firstChild, signout);
      } else {
        asideEl.insertAdjacentHTML('beforeend', html);
      }
    } catch (e) { console.warn('[sidebar] granted-admin inject failed', e); }
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

    // 2026-06-01 (Kenny) — keep the sidebar WITH the page. A full page reload used
    // to reset the (now long) sidebar to the top, leaving the current page's item
    // off-screen so users had to hunt for it. Restore the saved scroll position,
    // guarantee the active item is visible, and remember scroll as the user moves.
    try {
      var _saved = parseInt(sessionStorage.getItem('lymx_sb_scroll') || '', 10);
      if (!isNaN(_saved)) sidebar.scrollTop = _saved;
      var _act = sidebar.querySelector('a.active');
      if (_act) {
        var _t = _act.offsetTop, _b = _t + _act.offsetHeight;
        if (_t < sidebar.scrollTop || _b > sidebar.scrollTop + sidebar.clientHeight) {
          sidebar.scrollTop = Math.max(0, _t - sidebar.clientHeight / 2);
        }
      }
      var _stmr;
      sidebar.addEventListener('scroll', function () {
        clearTimeout(_stmr);
        _stmr = setTimeout(function () { try { sessionStorage.setItem('lymx_sb_scroll', String(sidebar.scrollTop)); } catch (e) {} }, 150);
      });
    } catch (e) { console.warn('[sidebar] scroll persist', e); }

    // 2026-05-31 — on app pages the sidebar owns APP navigation, so the page's top
    // app-tab bar (~25 links) is redundant and overflowed off-screen. Replace those
    // tabs with the standard PUBLIC website nav (like any site header) so logged-in
    // users can still reach the public site; app nav lives in the sidebar. Marketing
    // pages have no sidebar so they're untouched. Brand + avatar are separate, stay.
    try {
      var _pubNav = [['index.html','Home'],['browse.html','Browse'],['partners.html','Partners'],['why-lymx.html','Why LYMX'],['business.html','For Business'],['community.html','Community']];
      var _here = (location.pathname.split('/').pop() || '').toLowerCase();
      document.querySelectorAll('header .nav-links, .nav .nav-links').forEach(function (nl) {
        nl.innerHTML = _pubNav.map(function (it) {
          var on = it[0].toLowerCase() === _here ? ' class="on"' : '';
          return '<a' + on + ' href="' + it[0] + '">' + it[1] + '</a>';
        }).join('');
        nl.style.display = '';
      });
    } catch (e) { console.warn('[sidebar] public top nav', e); }

    var sout = document.getElementById('lymx-sb-signout');
    if (sout) sout.addEventListener('click', doSignout);

    sidebar.addEventListener('click', function (e) {
      var hd = e.target.closest && e.target.closest('.lymx-sb-grp-h');
      if (hd && hd.parentNode) {
        hd.parentNode.classList.toggle('open');
        try {
          var open = Array.prototype.map.call(sidebar.querySelectorAll('.lymx-sb-grp.open'), function (g) { return g.getAttribute('data-grp'); });
          _saveOpenGrps(open);
        } catch (e2) {}
      }
    });

    // 2026-05-24 — async DB role confirmation. If the first paint chose the
    // wrong role (e.g. landed on /profile.html with empty sessionStorage and
    // we guessed 'customer' but the user is a partner), this refreshes the
    // sidebar with the correct role and stashes the answer for instant
    // correct first paint on subsequent navigations within the session.
    (async function confirmRoleFromDb() {
      try {
        var prevCache = null; try { prevCache = sessionStorage.getItem('lymx_db_role'); } catch (e) {}
        var dbRole = await resolveRoleFromDb();
        if (!dbRole) return;
        _stashDbRole(dbRole);
        var rnk = { admin:4, partner:3, business:2, customer:1 };
        // 2026-05-31 — grouped sidebar: rebuild ONCE if DB role outranks the
        // PRE-paint cache. Comparing to prevCache (not the path role) prevents the
        // refresh->mount->refresh loop that made the sidebar flash.
        if ((rnk[dbRole]||0) > (rnk[prevCache]||0) && window.LymxSidebar && typeof window.LymxSidebar.refresh === 'function') {
          window.LymxSidebar.refresh();
        }
      } catch (e) { console.warn('[sidebar] confirmRoleFromDb', e); }
    })();

    // 2026-05-20 #4aa8c795 - async append "My Work" section for staff users.
    maybeInjectStaffSection(sidebar);
    maybeInjectGrantedAdminSection(sidebar);
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
          if (!r.ok) { try { sessionStorage.setItem(cacheKey, '__none__'); } catch (e) { console.warn('[lymx-sidebar] partner_code none cache', e); } return; }
          var rows = await r.json();
          code = (rows && rows[0] && rows[0].partner_code) || null;
          if (!code) { try { sessionStorage.setItem(cacheKey, '__none__'); } catch (e) { console.warn('[lymx-sidebar] partner_code none cache', e); } return; }
          try { sessionStorage.setItem(cacheKey, code); } catch (e) { console.warn('[lymx-sidebar] partner_code cache write', e); }
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
