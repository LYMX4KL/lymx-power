// =============================================================================
// LYMX universal page bootstrap — load this ONCE on every page.
// =============================================================================
// Adds:
//   - Supabase config (from lymx-config.js)
//   - Supabase Auth (lymx-auth.js)
//   - Persistent left sidebar (only when signed in)
//   - Floating feedback widget (auto-screenshot, uploads, AI assist)
//   - Universal nav helper (guest buttons swap, avatar dropdown, signup redirect)
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
      // Nav helper runs early so signup redirects happen before the user can interact.
      await loadScript('lymx-nav.js');
      await loadScript('lymx-sidebar.js');
      await loadScript('lymx-feedback.js');
    } catch (e) {
      console.warn('[lymx-app] partial load:', e && e.message);
    }
  })();
})();
