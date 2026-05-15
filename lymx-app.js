// =============================================================================
// LYMX universal page bootstrap — load this ONCE on every page.
// =============================================================================
// Adds:
//   - Supabase config (from lymx-config.js)
//   - Supabase Auth (lymx-auth.js → window.LYMX.getSession())
//   - Persistent left sidebar (only when signed in)
//   - Floating feedback widget (auto-screenshot, uploads, AI assist)
//
// Drop this single line right before </body> on EVERY page:
//
//     <script src="lymx-app.js" defer></script>
//
// You no longer need to include lymx-config/lymx-auth/lymx-sidebar/lymx-feedback
// individually — this one file pulls them in the correct order with no
// duplication.  If a page DOES still include them individually that's fine,
// this file is idempotent (each child checks its own __LOADED__ flag).
// =============================================================================

(function () {
  if (window.__LYMX_APP_LOADED__) return;
  window.__LYMX_APP_LOADED__ = true;

  function loadScript(src, attrs) {
    return new Promise(function (resolve, reject) {
      // Already on page?
      var existing = document.querySelector('script[src="' + src + '"]');
      if (existing) {
        if (existing.dataset.loaded === '1') return resolve();
        existing.addEventListener('load', function () { resolve(); });
        existing.addEventListener('error', function () { reject(new Error(src)); });
        return;
      }
      var s = document.createElement('script');
      s.src = src;
      if (attrs) Object.keys(attrs).forEach(function (k) { s.setAttribute(k, attrs[k]); });
      s.onload  = function () { s.dataset.loaded = '1'; resolve(); };
      s.onerror = function () { reject(new Error(src)); };
      document.head.appendChild(s);
    });
  }

  (async function bootstrap() {
    try {
      // 1) Supabase JS SDK (idempotent — re-using if already loaded)
      if (!window.supabase) {
        await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
      }
      // 2) LYMX config (provides window.LYMX_CONFIG)
      if (!window.LYMX_CONFIG) {
        await loadScript('lymx-config.js');
      }
      // 3) LYMX auth helper (provides window.LYMX.getSession)
      if (!window.LYMX || !window.LYMX.getSession) {
        await loadScript('lymx-auth.js');
      }
      // 4) Sidebar (only mounts when a session exists — controlled inside the file)
      await loadScript('lymx-sidebar.js');
      // 5) Feedback widget
      await loadScript('lymx-feedback.js');
    } catch (e) {
      console.warn('[lymx-app] partial load:', e && e.message);
    }
  })();
})();
