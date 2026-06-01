// =============================================================================
// LYMX Power — lymx-public-nav.js  (shared PUBLIC top-nav, single source of truth)
// =============================================================================
// 2026-06-01 #99149337 — ROOT CAUSE: the site is static HTML on Netlify with
// NO build step / templating (netlify.toml publish="."), so every page hand-rolls
// its own header. ~45 marketing/info pages were authored with a stripped bar
// (logo + "Sign up free" only, no nav links), so users "lost the top bar" moving
// between pages. The root fix is a SINGLE shared nav component included on every
// page — change the links here once and they update everywhere (no per-page drift,
// which is what created this problem). Mirrors the lymx-nav.js shared-UI pattern.
//
// Behaviour:
//   • If the page already has a real nav (a `.nav-links` element), do nothing —
//     this script never double-renders on pages that already ship a full header.
//   • Else, if the page has a minimal top bar (header/nav `.nav` + `.nav-inner`),
//     inject the canonical link row into it (between the logo and any CTA button),
//     reusing the page's own sticky bar + styling.
//   • Else (no bar at all), prepend a self-styled sticky bar with brand + links + CTA.
//
// Canonical links live in LINKS below — edit ONE place to change site-wide nav.
// =============================================================================
(function () {
  if (window.__LYMX_PUBNAV__) return;
  window.__LYMX_PUBNAV__ = true;

  // Single source of truth for the public top nav. [href, label].
  var LINKS = [
    ['index.html', 'Home'],
    ['how-lymx-works.html', 'How it works'],
    ['browse.html', 'Browse'],
    ['why-lymx.html', 'Why LYMX'],
    ['business.html', 'For Business'],
    ['partners.html', 'Partners']
  ];

  function injectStyles() {
    if (document.getElementById('lymx-pubnav-css')) return;
    var st = document.createElement('style');
    st.id = 'lymx-pubnav-css';
    st.textContent =
      '.lymx-pubnav-links{display:flex;gap:20px;align-items:center;font-size:14px;flex-wrap:wrap}' +
      '.lymx-pubnav-links a{color:#475569;text-decoration:none;font-weight:600;white-space:nowrap;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif}' +
      '.lymx-pubnav-links a:hover{color:#0050c7}' +
      '.lymx-pubnav-links a[aria-current="page"]{color:#0050c7}' +
      '@media(max-width:860px){.lymx-pubnav-links{display:none}}' +
      '.lymx-pubnav-bar{position:sticky;top:0;z-index:60;background:rgba(255,255,255,.95);backdrop-filter:saturate(180%) blur(10px);-webkit-backdrop-filter:saturate(180%) blur(10px);border-bottom:1px solid #e6e8ec}' +
      '.lymx-pubnav-inner{max-width:1100px;margin:0 auto;padding:13px 24px;display:flex;align-items:center;justify-content:space-between;gap:20px}' +
      '.lymx-pubnav-brand{font-weight:800;font-size:18px;color:#0e1116;text-decoration:none;letter-spacing:-.02em}' +
      '.lymx-pubnav-cta{padding:8px 14px;border:1px solid #0e1116;border-radius:8px;color:#0e1116;font-weight:700;font-size:13px;text-decoration:none;white-space:nowrap}' +
      '.lymx-pubnav-cta:hover{background:#0e1116;color:#fff}';
    document.head.appendChild(st);
  }

  function buildLinksNav() {
    var here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    var nav = document.createElement('nav');
    nav.className = 'lymx-pubnav-links';
    nav.setAttribute('aria-label', 'Primary');
    nav.innerHTML = LINKS.map(function (l) {
      var on = l[0].toLowerCase() === here ? ' aria-current="page"' : '';
      return '<a' + on + ' href="' + l[0] + '">' + l[1] + '</a>';
    }).join('');
    return nav;
  }

  function run() {
    // 1) Page already ships a real nav — leave it alone.
    if (document.querySelector('.nav-links')) return;
    if (!document.body) return;

    injectStyles();
    var links = buildLinksNav();

    // 2) Reuse an existing minimal bar if present.
    var inner = document.querySelector('header.nav .nav-inner, nav.nav .nav-inner, .nav .nav-inner');
    var barEl = inner || document.querySelector('header.nav, nav.nav');
    if (barEl) {
      var container = barEl.classList && barEl.classList.contains('nav-inner') ? barEl : (barEl.querySelector('.nav-inner') || barEl);
      var cta = container.querySelector('a.btn, .btn, .nav-cta, a.cta');
      if (cta) container.insertBefore(links, cta);
      else container.appendChild(links);
      return;
    }

    // 3) No bar at all — build a full sticky one.
    var hdr = document.createElement('header');
    hdr.className = 'lymx-pubnav-bar';
    var box = document.createElement('div');
    box.className = 'lymx-pubnav-inner';
    var brand = document.createElement('a');
    brand.className = 'lymx-pubnav-brand';
    brand.href = 'index.html';
    brand.textContent = 'LYMX';
    var cta = document.createElement('a');
    cta.className = 'lymx-pubnav-cta';
    cta.href = 'customer-signup.html';
    cta.textContent = 'Sign up free →';
    box.appendChild(brand);
    box.appendChild(links);
    box.appendChild(cta);
    hdr.appendChild(box);
    document.body.insertBefore(hdr, document.body.firstChild);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
