// LYMX sidebar — persistent left-rail navigation for every dashboard.
// Inspired by InvestPro PM's team-sidebar.js pattern.
//
// Usage: drop this single line into any dashboard page (before </body>):
//
//     <script src="lymx-sidebar.js" defer></script>
//
// The script auto-detects which role's dashboard the user is on (from the
// page filename) and prepends a fixed left-rail menu. On screens <900px it
// collapses into a top horizontal scrollbar so it doesn't eat content room.

(function () {
  if (window.__LYMX_SIDEBAR_LOADED__) return;
  window.__LYMX_SIDEBAR_LOADED__ = true;

  // ---------- Role detection ----------
  // Inferred from the path; can be overridden by <body data-lymx-role="admin">.
  function detectRole() {
    var override = document.body && document.body.getAttribute('data-lymx-role');
    if (override) return override;
    var path = (location.pathname || '').toLowerCase();
    if (/\/admin-/.test(path) || /admin-dashboard\.html$/.test(path)) return 'admin';
    if (/\/biz-/.test(path) || /biz-dashboard\.html$/.test(path) || /business-dashboard\.html$/.test(path)) return 'business';
    if (/\/(rep-|partner-)/.test(path) || /rep-dashboard\.html$/.test(path)) return 'partner';
    if (/customer-dashboard\.html$/.test(path) || /customer-wallet\.html$/.test(path)) return 'customer';
    // Default to whatever <body data-role> says, else "customer"
    return (document.body && document.body.getAttribute('data-role')) || 'customer';
  }

  // ---------- Menu definitions per role ----------
  // Each item: { href, icon, label, exact? }
  // `active` is highlighted when location.pathname endsWith href.
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
      { href: 'admin-invite-friends.html', icon: '📨', label: 'Invite Friends' },
      { href: 'contacts.html',           icon: '📇', label: 'Contacts' },
      { href: 'my-feedback.html',        icon: '📝', label: 'My Feedback' },
    ],
    admin: [
      { section: '🛠️ Admin' },
      { href: 'admin-dashboard.html',    icon: '📊', label: 'Dashboard' },
      { href: 'admin-tech-support.html', icon: '🎧', label: 'Tech Support' },
      { href: 'admin-chat.html',         icon: '💬', label: 'Team Chat' },
      { href: 'admin-broadcast.html',    icon: '📢', label: 'Broadcast' },
      { section: '🏢 Network' },
      { href: 'admin-businesses.html',   icon: '🏢', label: 'Businesses' },
      { href: 'admin-promos.html',       icon: '🎁', label: 'Promos' },
      { href: 'admin-approvals.html',    icon: '✅', label: 'Approvals' },
      { href: 'admin-staff.html',        icon: '👥', label: 'Staff Roles' },
      { section: '📨 Outreach' },
      { href: 'admin-invite-friends.html', icon: '📨', label: 'Invite Friends' },
      { href: 'contacts.html',           icon: '📇', label: 'Contacts' },
      { section: '⚙️ Account' },
      { href: 'my-feedback.html',        icon: '📝', label: 'My Feedback' },
    ]
  };

  // ---------- CSS ----------
  function injectStyles() {
    if (document.getElementById('lymx-sidebar-styles')) return;
    var style = document.createElement('style');
    style.id = 'lymx-sidebar-styles';
    style.textContent = ''
      // Fixed-position left rail so the page content keeps its own natural
      // width (the dashboards already use .wrap{max-width:1200px;margin:0 auto},
      // .grid{1fr 360px}, etc. — we don't want to fight those layouts).
      + '.lymx-sb{position:fixed;left:14px;top:84px;width:232px;max-height:calc(100vh - 100px);overflow-y:auto;background:#fff;border:1px solid #e6e8ec;border-radius:12px;padding:12px 10px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;box-shadow:0 4px 14px rgba(14,17,22,.06);z-index:30}'
      + '.lymx-sb h3{font-size:11px;font-weight:800;color:#0a84ff;margin:6px 8px 4px;padding:0;text-transform:uppercase;letter-spacing:.08em}'
      + '.lymx-sb h3:first-child{margin-top:0}'
      + '.lymx-sb a{display:flex;align-items:center;gap:9px;padding:8px 11px;margin-bottom:2px;background:transparent;border:0;border-radius:7px;color:#1a1f27;text-decoration:none;cursor:pointer;font:600 13px/1.2 inherit;text-align:left;transition:background .12s,color .12s}'
      + '.lymx-sb a:hover{background:#eef4ff;color:#0a84ff}'
      + '.lymx-sb a.active{background:#0e1116;color:#fff}'
      + '.lymx-sb a.active:hover{background:#1a1f27;color:#fff}'
      + '.lymx-sb .lymx-sb-icon{font-size:14px;flex-shrink:0;width:18px;text-align:center}'
      // Shift the entire page right to make room for the sidebar.
      + '.lymx-sb-pushed{padding-left:260px}'
      + '@media(max-width:1100px){'
      + '  .lymx-sb{display:none}'   // hide rail on narrow viewports
      + '  .lymx-sb-pushed{padding-left:0}'
      + '}';
    document.head.appendChild(style);
  }

  // ---------- Build markup ----------
  function buildSidebar(role) {
    var items = MENUS[role] || MENUS.customer;
    var aside = document.createElement('aside');
    aside.className = 'lymx-sb';
    aside.setAttribute('aria-label', role + ' navigation');
    var html = '';
    var here = (location.pathname.split('/').pop() || '').toLowerCase();
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
    aside.innerHTML = html;
    return aside;
  }

  // ---------- Mount: append a fixed-position sidebar; push body content right
  // ----  Approach (Kenny 2026-05-14 fix): don't wrap the page in a flex
  //       layout — that broke the existing centered .wrap and 1fr/360px grid
  //       and left empty space on the right. Instead, render the sidebar as
  //       a fixed-position rail and add padding-left to <body> so nothing
  //       overlaps. Pages keep their own natural width.
  function mount() {
    if (!document.body) return setTimeout(mount, 50);
    if (document.querySelector('.lymx-sb')) return;  // already mounted

    injectStyles();
    var role = detectRole();
    document.body.appendChild(buildSidebar(role));
    document.body.classList.add('lymx-sb-pushed');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
