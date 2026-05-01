/**
 * LYMX cookie consent banner
 * Self-contained — no external deps, no remote calls.
 *
 * Add to any page with: <script src="cookie-consent.js" defer></script>
 *
 * Stores user choice in localStorage as `lymx-cookie-consent`:
 *   - "all"        → user accepted analytics + everything
 *   - "essential"  → user rejected non-essential
 *   - "custom"     → user customized; full prefs in `lymx-cookie-prefs`
 *
 * Banner does NOT show if a choice has already been made.
 *
 * To force-reset for testing, run in browser console:
 *   localStorage.removeItem('lymx-cookie-consent');
 *   localStorage.removeItem('lymx-cookie-prefs');
 *   location.reload();
 */

(function() {
  'use strict';

  // Skip if user has already chosen
  if (localStorage.getItem('lymx-cookie-consent')) return;

  // Inject styles
  const style = document.createElement('style');
  style.textContent = `
    .lymx-cookie-banner {
      position: fixed; left: 16px; right: 16px; bottom: 16px;
      max-width: 640px; margin: 0 auto;
      background: #0e1116; color: #fff;
      border-radius: 14px;
      box-shadow: 0 14px 40px rgba(14,17,22,.32);
      padding: 22px 26px;
      z-index: 9999;
      font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
      font-size: 14px;
      line-height: 1.55;
      animation: lymx-cb-in .35s ease-out;
    }
    @keyframes lymx-cb-in {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .lymx-cookie-banner .lymx-cb-h {
      font-size: 14px; font-weight: 800; margin: 0 0 6px;
      display: flex; align-items: center; gap: 8px;
    }
    .lymx-cookie-banner .lymx-cb-body {
      color: #c6ccd4; font-size: 13.5px; margin: 0 0 16px;
    }
    .lymx-cookie-banner .lymx-cb-body a {
      color: #5fd198; font-weight: 700; text-decoration: none;
    }
    .lymx-cookie-banner .lymx-cb-actions {
      display: flex; gap: 8px; flex-wrap: wrap;
    }
    .lymx-cookie-banner button {
      padding: 9px 16px; border-radius: 9px; font-weight: 700; font-size: 13px;
      border: 0; cursor: pointer; font-family: inherit;
      transition: .15s;
    }
    .lymx-cookie-banner .lymx-cb-accept {
      background: #f5d172; color: #0e1116;
    }
    .lymx-cookie-banner .lymx-cb-accept:hover { background: #fff; }
    .lymx-cookie-banner .lymx-cb-essential,
    .lymx-cookie-banner .lymx-cb-custom {
      background: rgba(255,255,255,.1); color: #fff; border: 1px solid rgba(255,255,255,.18);
    }
    .lymx-cookie-banner .lymx-cb-essential:hover,
    .lymx-cookie-banner .lymx-cb-custom:hover {
      background: rgba(255,255,255,.18);
    }

    /* Customize panel */
    .lymx-cookie-banner .lymx-cb-panel {
      display: none; margin-top: 14px; padding-top: 14px;
      border-top: 1px solid rgba(255,255,255,.12);
    }
    .lymx-cookie-banner .lymx-cb-panel.on { display: block; }
    .lymx-cookie-banner .lymx-cb-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 0; gap: 14px;
      border-bottom: 1px solid rgba(255,255,255,.08);
    }
    .lymx-cookie-banner .lymx-cb-row:last-child { border-bottom: 0; }
    .lymx-cookie-banner .lymx-cb-row .lymx-cb-l { flex: 1; min-width: 0; }
    .lymx-cookie-banner .lymx-cb-row .lymx-cb-h2 {
      font-weight: 800; font-size: 13px; color: #fff;
    }
    .lymx-cookie-banner .lymx-cb-row .lymx-cb-d {
      font-size: 12px; color: #9aa3b0; margin-top: 1px;
    }
    /* Toggle switch */
    .lymx-cb-toggle {
      position: relative; width: 38px; height: 22px;
      background: rgba(255,255,255,.18); border-radius: 99px;
      cursor: pointer; transition: .15s;
      flex-shrink: 0;
    }
    .lymx-cb-toggle.on { background: #5fd198; }
    .lymx-cb-toggle.locked { opacity: .5; cursor: not-allowed; }
    .lymx-cb-toggle::after {
      content: ""; position: absolute; top: 2px; left: 2px;
      width: 18px; height: 18px; background: #fff; border-radius: 50%;
      transition: .15s;
    }
    .lymx-cb-toggle.on::after { left: 18px; }

    /* Mobile adjustments */
    @media (max-width: 480px) {
      .lymx-cookie-banner { padding: 18px 20px; }
      .lymx-cookie-banner .lymx-cb-actions { flex-direction: column; }
      .lymx-cookie-banner button { width: 100%; }
    }
  `;
  document.head.appendChild(style);

  // Build banner
  const banner = document.createElement('div');
  banner.className = 'lymx-cookie-banner';
  banner.setAttribute('role', 'dialog');
  banner.setAttribute('aria-label', 'Cookie preferences');
  banner.innerHTML = `
    <div class="lymx-cb-h">🍪 We use a few cookies</div>
    <div class="lymx-cb-body">
      LYMX uses essential cookies to keep you signed in and the wallet working. With your permission, we also use a small amount of privacy-respecting analytics to understand which pages get used. We <strong>do not</strong> sell your data, and we don't run third-party advertising trackers.
      <a href="privacy.html">Privacy Policy →</a>
    </div>
    <div class="lymx-cb-actions">
      <button class="lymx-cb-accept" type="button">Accept all</button>
      <button class="lymx-cb-essential" type="button">Essential only</button>
      <button class="lymx-cb-custom" type="button">Customize</button>
    </div>
    <div class="lymx-cb-panel">
      <div class="lymx-cb-row">
        <div class="lymx-cb-l">
          <div class="lymx-cb-h2">Essential</div>
          <div class="lymx-cb-d">Required to keep you signed in and process transactions. Cannot be disabled.</div>
        </div>
        <div class="lymx-cb-toggle on locked"></div>
      </div>
      <div class="lymx-cb-row">
        <div class="lymx-cb-l">
          <div class="lymx-cb-h2">Analytics</div>
          <div class="lymx-cb-d">Aggregate page-view stats. No cross-site tracking, no third-party advertising.</div>
        </div>
        <div class="lymx-cb-toggle on" data-pref="analytics"></div>
      </div>
      <div class="lymx-cb-row">
        <div class="lymx-cb-l">
          <div class="lymx-cb-h2">Functional</div>
          <div class="lymx-cb-d">Remembers your filter and sort preferences across sessions.</div>
        </div>
        <div class="lymx-cb-toggle on" data-pref="functional"></div>
      </div>
      <div style="margin-top: 12px; text-align: right;">
        <button class="lymx-cb-accept" type="button" style="background: #5fd198; color: #0e1116;">Save preferences</button>
      </div>
    </div>
  `;
  document.body.appendChild(banner);

  // Wire up
  const close = () => {
    banner.style.opacity = '0';
    banner.style.transform = 'translateY(20px)';
    setTimeout(() => banner.remove(), 220);
  };

  banner.querySelectorAll('.lymx-cb-accept').forEach(btn => {
    btn.addEventListener('click', () => {
      // If panel is open, save customized prefs; else accept all
      const panel = banner.querySelector('.lymx-cb-panel');
      if (panel.classList.contains('on')) {
        const prefs = { essential: true };
        panel.querySelectorAll('.lymx-cb-toggle[data-pref]').forEach(t => {
          prefs[t.dataset.pref] = t.classList.contains('on');
        });
        localStorage.setItem('lymx-cookie-consent', 'custom');
        localStorage.setItem('lymx-cookie-prefs', JSON.stringify(prefs));
      } else {
        localStorage.setItem('lymx-cookie-consent', 'all');
        localStorage.setItem('lymx-cookie-prefs', JSON.stringify({ essential: true, analytics: true, functional: true }));
      }
      close();
    });
  });

  banner.querySelector('.lymx-cb-essential').addEventListener('click', () => {
    localStorage.setItem('lymx-cookie-consent', 'essential');
    localStorage.setItem('lymx-cookie-prefs', JSON.stringify({ essential: true, analytics: false, functional: false }));
    close();
  });

  banner.querySelector('.lymx-cb-custom').addEventListener('click', () => {
    banner.querySelector('.lymx-cb-panel').classList.toggle('on');
  });

  // Toggle switches
  banner.querySelectorAll('.lymx-cb-toggle:not(.locked)').forEach(t => {
    t.addEventListener('click', () => t.classList.toggle('on'));
  });
})();
