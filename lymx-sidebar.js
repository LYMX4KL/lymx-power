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
      + '.lymx-sb-layout{display:flex;gap:20px;align-items:flex-start;padding:0;max-width:1320px;margin:0 auto;width:100%}'
      + '.lymx-sb{width:236px;flex-shrink:0;background:#fff;border:1px solid #e6e8ec;border-radius:12px;padding:14px 10px;position:sticky;top:88px;max-height:calc(100vh - 110px);overflow-y:auto;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;box-shadow:0 4px 14px rgba(14,17,22,.04)}'
      + '.lymx-sb h3{font-size:11px;font-weight:800;color:#0a84ff;margin:6px 8px 4px;padding:0;text-transform:uppercase;letter-spacing:.08em}'
      + '.lymx-sb h3:first-child{margin-top:0}'
      + '.lymx-sb a{display:flex;align-items:center;gap:9px;padding:9px 11px;margin-bottom:2px;background:transparent;border:0;border-radius:7px;color:#1a1f27;text-decoration:none;cursor:pointer;font:600 13.5px/1.2 inherit;text-align:left;transition:background .12s,color .12s}'
      + '.lymx-sb a:hover{background:#eef4ff;color:#0a84ff}'
      + '.lymx-sb a.active{background:#0e1116;color:#fff}'
      + '.lymx-sb a.active:hover{background:#1a1f27;color:#fff}'
      + '.lymx-sb .lymx-sb-icon{font-size:14px;flex-shrink:0;width:18px;text-align:center}'
      + '.lymx-sb-content{flex:1;min-width:0}'
      + '@media(max-width:980px){'
      + '  .lymx-sb-layout{flex-direction:column;gap:8px;padding:0 4px}'
      + '  .lymx-sb{width:100%;position:static;max-height:none;display:flex;flex-direction:row;flex-wrap:nowrap;overflow-x:auto;gap:2px;padding:6px 8px;margin-bottom:2px}'
      + '  .lymx-sb h3{display:none}'
      + '  .lymx-sb a{flex-shrink:0;white-space:nowrap;margin-bottom:0;padding:7px 10px}'
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

  // ---------- Mount: wrap <main> in a flex layout with sidebar on left ----------
  function mount() {
    if (!document.body) return setTimeout(mount, 50);
    if (document.querySelector('.lymx-sb')) return;  // already mounted

    injectStyles();
    var role = detectRole();

    // Find the main container to wrap. Prefer <main>, fall back to first
    // <section> after the header, else just body.
    var target = document.querySelector('main')
              || document.querySelector('section.dash')
              || document.querySelector('.wrap')
              || document.body;

    // Avoid double-wrapping if the page already uses a custom layout
    if (target === document.body) {
      // Inject a wrapper around all top-level <section>s
      var wrapper = document.createElement('div');
      wrapper.className = 'lymx-sb-layout';
      var content = document.createElement('div');
      content.className = 'lymx-sb-content';
      wrapper.appendChild(buildSidebar(role));
      wrapper.appendChild(content);
      // Move every child after the <header> into the content div
      var header = document.querySelector('header');
      var nextNode = header ? header.nextSibling : document.body.firstChild;
      while (nextNode) {
        var toMove = nextNode;
        nextNode = nextNode.nextSibling;
        if (toMove.nodeType === 1 && toMove.tagName.toLowerCase() === 'footer') break;
        content.appendChild(toMove);
      }
      // Insert the wrapper before whatever's left (footer/scripts)
      if (header && header.parentNode) header.parentNode.insertBefore(wrapper, header.nextSibling);
      else document.body.insertBefore(wrapper, document.body.firstChild);
    } else {
      // Wrap the target with a flex layout
      var parent = target.parentNode;
      var wrap2 = document.createElement('div');
      wrap2.className = 'lymx-sb-layout';
      parent.insertBefore(wrap2, target);
      wrap2.appendChild(buildSidebar(role));
      var content2 = document.createElement('div');
      content2.className = 'lymx-sb-content';
      wrap2.appendChild(content2);
      content2.appendChild(target);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
