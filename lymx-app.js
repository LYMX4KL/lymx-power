// =============================================================================
// LYMX universal page bootstrap — load this ONCE on every page.
// =============================================================================
// Adds:
//   - Supabase config (from lymx-config.js)
//   - Supabase Auth (lymx-auth.js)
//   - Persistent left sidebar (only when signed in)
//   - Floating feedback widget (auto-screenshot, uploads, AI assist)
//   - Universal nav helper (guest buttons swap, avatar dropdown, signup redirect)
//   - Auto-injects PWA meta tags + manifest + apple-touch-icon if not already
//     in the page (so "Add to Home Screen" works on iPhone / Android with the
//     proper LYMX brand icon).
//
// Drop this single line right before </body> on EVERY page:
//
//     <script src="lymx-app.js" defer></script>
//
// Idempotent — each child checks its own __LOADED__ flag.
// =============================================================================

(function () {
  if (window.__LYMX_APP_LOADED__) return;
  window.__LYMX_APP_LOADED__ = true;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[src="' + src + '"]');
      if (existing) {
        if (existing.dataset.loaded === '1') return resolve();
        existing.addEventListener('load', function () { resolve(); });
        existing.addEventListener('error', function () { reject(new Error(src)); });
        setTimeout(function () { resolve(); }, 1500);
        return;
      }
      var s = document.createElement('script');
      s.src = src;
      s.onload  = function () { s.dataset.loaded = '1'; resolve(); };
      s.onerror = function () { reject(new Error(src)); };
      document.head.appendChild(s);
    });
  }

  // -----------------------------------------------------------------
  // Inject PWA / mobile-icon meta tags if the page doesn't already have them.
  // -----------------------------------------------------------------
  function ensureTag(selector, build) {
    if (document.head.querySelector(selector)) return;
    var el = build();
    document.head.appendChild(el);
  }
  function injectPwaTags() {
    ensureTag('meta[name="viewport"]', function () {
      var m = document.createElement('meta');
      m.name = 'viewport';
      m.content = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
      return m;
    });
    ensureTag('meta[name="theme-color"]', function () {
      var m = document.createElement('meta');
      m.name = 'theme-color';
      m.content = '#0a84ff';
      return m;
    });
    ensureTag('meta[name="apple-mobile-web-app-capable"]', function () {
      var m = document.createElement('meta');
      m.name = 'apple-mobile-web-app-capable';
      m.content = 'yes';
      return m;
    });
    ensureTag('meta[name="apple-mobile-web-app-status-bar-style"]', function () {
      var m = document.createElement('meta');
      m.name = 'apple-mobile-web-app-status-bar-style';
      m.content = 'default';
      return m;
    });
    ensureTag('meta[name="apple-mobile-web-app-title"]', function () {
      var m = document.createElement('meta');
      m.name = 'apple-mobile-web-app-title';
      m.content = 'LYMX';
      return m;
    });
    ensureTag('meta[name="mobile-web-app-capable"]', function () {
      var m = document.createElement('meta');
      m.name = 'mobile-web-app-capable';
      m.content = 'yes';
      return m;
    });
    ensureTag('link[rel="apple-touch-icon"]', function () {
      var l = document.createElement('link');
      l.rel = 'apple-touch-icon';
      l.setAttribute('sizes', '180x180');
      l.href = 'apple-touch-icon.png';
      return l;
    });
    ensureTag('link[rel="manifest"]', function () {
      var l = document.createElement('link');
      l.rel = 'manifest';
      l.href = 'manifest.webmanifest';
      return l;
    });
    ensureTag('link[rel="icon"][sizes="192x192"]', function () {
      var l = document.createElement('link');
      l.rel = 'icon';
      l.type = 'image/png';
      l.setAttribute('sizes', '192x192');
      l.href = 'icon-192.png';
      return l;
    });
    ensureTag('link[rel="icon"][sizes="512x512"]', function () {
      var l = document.createElement('link');
      l.rel = 'icon';
      l.type = 'image/png';
      l.setAttribute('sizes', '512x512');
      l.href = 'icon-512.png';
      return l;
    });
  }

  try { injectPwaTags(); } catch (e) { console.warn('[lymx-app] PWA inject failed:', e); }

  (async function bootstrap() {
    try {
      if (!window.supabase) {
        await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
      }
      if (!window.LYMX_CONFIG) {
        await loadScript('lymx-config.js');
      }
      if (!window.LYMX || !window.LYMX.getSession) {
        await loadScript('lymx-auth.js');
      }
      await loadScript('lymx-nav.js');
      await loadScript('lymx-sidebar.js');
      await loadScript('lymx-feedback.js');
      // 2026-05-26 — universal page-share pill (bottom-left), companion to
      // the Help & Feedback pill (bottom-right). Born from feedback ticket
      // c015b0ed "make all pages shable" + Kenny's follow-up that pages
      // must be shareable with prominent CTA + mobile-friendly. Pages can
      // opt out with <body data-no-share-btn="true">.
      await loadScript('lymx-share.js');
      // 2026-05-24 T-6ABF51 / T-B78E5A — biz profile Save + Share wiring.
      // No-ops on non-biz pages (internal isBizProfilePage gate).
      await loadScript('lymx-biz-actions.js');
      // i18n loads last so it can translate whatever nav/sidebar/feedback injected.
      await loadScript('lymx-i18n.js');
    } catch (e) {
      console.warn('[lymx-app] partial load:', e && e.message);
    }
  })();
})();
