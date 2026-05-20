// LYMX shared client config + PWA tag injection.
// ---------------------------------------------------------------------------
// Loaded on EVERY page (255/255). Two responsibilities:
//   1. Expose window.LYMX_CONFIG for Supabase calls.
//   2. Auto-inject PWA / mobile-icon meta tags so the page works for
//      "Add to Home Screen" on iPhone & Android, even on pages that don't
//      load lymx-app.js.
//
// SUPABASE_ANON_KEY is the public "anon public" key from
// https://supabase.com/dashboard/project/apffootxzfwmtyjlnteo/settings/api-keys/legacy
// It IS safe to embed in client code — it's the public anon key, not
// the service_role key.
// ---------------------------------------------------------------------------

window.LYMX_CONFIG = {
  SUPABASE_URL: 'https://apffootxzfwmtyjlnteo.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFwZmZvb3R4emZ3bXR5amxudGVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2NjMxNjksImV4cCI6MjA5MzIzOTE2OX0.05FqSREKhwOz7zAtz70UXPuNXtPNl_YfH8WLYo79DtE',
  // Google OAuth Client ID (public, safe to ship). Set this once you've created
  // an OAuth 2.0 Web client in Google Cloud Console and added
  // https://getlymx.com/google-oauth-done.html to its Authorized redirect URIs.
  // The Client SECRET stays in Supabase secrets as GOOGLE_OAUTH_CLIENT_SECRET — never put it here.
  GOOGLE_OAUTH_CLIENT_ID: '108170223593-4hfk5ilud07p2ff3bt74k2ne55mtsh2p.apps.googleusercontent.com'
};

// ----- PWA tag injection (idempotent, runs synchronously at parse time) -----
(function injectPwaTags() {
  if (!document || !document.head) return;
  function ensure(selector, build) {
    if (document.head.querySelector(selector)) return;
    document.head.appendChild(build());
  }
  // Mobile viewport (safety net — most pages already have one)
  ensure('meta[name="viewport"]', function () {
    var m = document.createElement('meta');
    m.name = 'viewport';
    m.content = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
    return m;
  });
  // Theme color (mobile address-bar tint)
  ensure('meta[name="theme-color"]', function () {
    var m = document.createElement('meta');
    m.name = 'theme-color';
    m.content = '#0a84ff';
    return m;
  });
  // iOS web-app meta
  ensure('meta[name="apple-mobile-web-app-capable"]', function () {
    var m = document.createElement('meta');
    m.name = 'apple-mobile-web-app-capable';
    m.content = 'yes';
    return m;
  });
  ensure('meta[name="apple-mobile-web-app-status-bar-style"]', function () {
    var m = document.createElement('meta');
    m.name = 'apple-mobile-web-app-status-bar-style';
    m.content = 'default';
    return m;
  });
  ensure('meta[name="apple-mobile-web-app-title"]', function () {
    var m = document.createElement('meta');
    m.name = 'apple-mobile-web-app-title';
    m.content = 'LYMX';
    return m;
  });
  ensure('meta[name="mobile-web-app-capable"]', function () {
    var m = document.createElement('meta');
    m.name = 'mobile-web-app-capable';
    m.content = 'yes';
    return m;
  });
  // Remove any old apple-touch-icon pointing at favicon.png so the new
  // 180x180 mark wins.
  var oldApple = document.head.querySelector('link[rel="apple-touch-icon"][href*="favicon"]');
  if (oldApple) oldApple.remove();
  ensure('link[rel="apple-touch-icon"]', function () {
    var l = document.createElement('link');
    l.rel = 'apple-touch-icon';
    l.setAttribute('sizes', '180x180');
    l.href = 'apple-touch-icon.png';
    return l;
  });
  // PWA manifest
  ensure('link[rel="manifest"]', function () {
    var l = document.createElement('link');
    l.rel = 'manifest';
    l.href = 'manifest.webmanifest';
    return l;
  });
  // Large icon links for browsers that prefer them
  ensure('link[rel="icon"][sizes="192x192"]', function () {
    var l = document.createElement('link');
    l.rel = 'icon';
    l.type = 'image/png';
    l.setAttribute('sizes', '192x192');
    l.href = 'icon-192.png';
    return l;
  });
  ensure('link[rel="icon"][sizes="512x512"]', function () {
    var l = document.createElement('link');
    l.rel = 'icon';
    l.type = 'image/png';
    l.setAttribute('sizes', '512x512');
    l.href = 'icon-512.png';
    return l;
  });
})();

// ─── Referral ID persistence (#be5638b6) ────────────────────────────────────
// When ANY LYMX page is opened with ?ref=<code>, persist the code so the
// referral survives click-throughs to other pages, browser restarts (30-day
// TTL), and finally the user landing on a signup page.
//
// Three guarantees:
//   1. URL  → sessionStorage + localStorage (with 30-day TTL).
//   2. If a page is opened WITHOUT ?ref= but the storage has one, the URL is
//      transparently patched via history.replaceState BEFORE any inline
//      script reads location.search. (lymx-config.js is loaded sync, early.)
//   3. Internal anchors on every page get the ref appended at DOMContentLoaded
//      so subsequent clicks preserve attribution.
// ----------------------------------------------------------------------------
(function lymxRefPersist() {
  if (!window || !document) return;
  var REF_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  var REF_KEY    = 'LYMX_REF';

  function clean(raw) {
    if (raw == null) return null;
    var s = String(raw).replace(/[^a-z0-9-]/gi, '').slice(0, 64);
    return s || null;
  }
  function readStoredRef() {
    try {
      var ss = sessionStorage.getItem(REF_KEY);
      if (ss) return clean(ss);
    } catch (_) {}
    try {
      var raw = localStorage.getItem(REF_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && p.v && (Date.now() - (p.t || 0) < REF_TTL_MS)) return clean(p.v);
        if (p) { try { localStorage.removeItem(REF_KEY); } catch (_) {} }
      }
    } catch (_) {}
    return null;
  }
  function writeRef(val) {
    var v = clean(val);
    if (!v) return;
    try { sessionStorage.setItem(REF_KEY, v); } catch (_) {}
    try { localStorage.setItem(REF_KEY, JSON.stringify({ v: v, t: Date.now() })); } catch (_) {}
  }

  // Public helper — signup pages can call window.LYMX_getRef() if they want
  // to look up the ref without relying on URL.
  window.LYMX_getRef = function () {
    try {
      var u = new URLSearchParams(location.search).get('ref');
      if (u) return clean(u);
    } catch (_) {}
    return readStoredRef();
  };

  // 1. Capture ?ref= from URL.
  var urlRef = null;
  try { urlRef = new URLSearchParams(location.search).get('ref'); } catch (e) { console.warn('[lymx-config.js:L165] silent error', e); }
  if (urlRef) writeRef(urlRef);

  // 2. If URL has no ref but storage does, replaceState so inline scripts
  //    that read params.get('ref') still find it.
  if (!urlRef) {
    var stored = readStoredRef();
    if (stored) {
      try {
        var url = new URL(location.href);
        if (!url.searchParams.has('ref')) {
          url.searchParams.set('ref', stored);
          history.replaceState(history.state, '', url.toString());
        }
      } catch (e) { console.warn('[lymx-config.js:L179] silent error', e); }
    }
  }

  // 3. Rewrite internal anchor href's at DOMContentLoaded so clicks carry
  //    the ref forward.
  function rewriteLinks() {
    var ref = window.LYMX_getRef();
    if (!ref) return;
    var anchors = document.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) {
      try {
        var a = anchors[i];
        var href = a.getAttribute('href');
        if (!href) continue;
        if (href.charAt(0) === '#') continue;
        if (/^(mailto:|tel:|sms:|javascript:|data:|blob:)/i.test(href)) continue;
        var url;
        try { url = new URL(href, location.origin); } catch (_) { continue; }
        if (url.host !== location.host) continue; // external — leave alone
        if (url.searchParams.has('ref')) continue;
        url.searchParams.set('ref', ref);
        // Preserve relative form if original was relative
        if (/^https?:\/\//i.test(href)) {
          a.setAttribute('href', url.toString());
        } else {
          a.setAttribute('href', url.pathname + url.search + url.hash);
        }
      } catch (e) { console.warn('[lymx-config.js:L207] silent error', e); }
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', rewriteLinks);
  } else {
    rewriteLinks();
  }
})();
