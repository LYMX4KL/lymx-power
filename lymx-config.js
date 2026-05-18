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
  GOOGLE_OAUTH_CLIENT_ID: ''
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
