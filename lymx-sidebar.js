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
      + '.lymx-sb h3{font-size:11