// LYMX universal page-share helper — runs on EVERY page via lymx-app.js.
// =============================================================================
// Born 2026-05-26 from feedback tickets c015b0ed ("make all pages shable")
// and Kenny's follow-up: "use the topic of that page as subject" + "make our
// existing pages shareable with CTA, make them mobile friendly".
//
// What it does:
//   1) Injects a fixed "↗ Share" pill at bottom-LEFT on every page. (The
//      Help & Feedback pill from lymx-feedback.js sits bottom-right; the two
//      do not overlap.)
//   2) Click → Web Share API on mobile (native share sheet), clipboard
//      fallback on desktop, prompt() as last resort.
//   3) Share TITLE = page topic, derived in priority order:
//        a) <body data-share-title="...">           — page can override
//        b) <meta property="og:title">              — SEO source of truth
//        c) first <h1> textContent                  — visible heading
//        d) document.title minus " — LYMX Power"    — last resort
//   4) Share URL = current URL with:
//        - any existing ?ref= preserved (so the original attribution chain
//          is honored — see share-to-earn rules)
//        - OR if signed-in user owns a partner code (from sessionStorage
//          LYMX_partner_code_<uid> cache populated by lymx-sidebar.js),
//          their code is added as ?ref=P-XXXXXX so SHARING earns LYMX
//          per the share-to-earn rewards spec.
//        - hash (#section) preserved
//   5) Pages can opt out with <body data-no-share-btn="true"> (mirrors the
//      lymx-feedback opt-out pattern). Login page is the only auto-opt-out
//      so far — sharing a login URL isn't useful.
//
// Design notes:
//   - No try/catch around pure DOM reads (querySelector, getAttribute,
//     document.title). Those don't throw; wrapping them in try/catch is
//     defensive theater. The few try/catch blocks below are around JSON.parse
//     of localStorage values (which CAN throw on corrupt data) and the URL
//     constructor (which throws on malformed location.href — extremely rare
//     but possible). Each one returns a sensible fallback inline so behavior
//     stays predictable.
//   - Idempotent — checks __LYMX_SHARE_LOADED__.
// =============================================================================

(function () {
  if (window.__LYMX_SHARE_LOADED__) return;
  window.__LYMX_SHARE_LOADED__ = true;

  // ----- utility: read this user's partner code from sidebar's cache --------
  // lymx-sidebar.js writes LYMX_partner_code_<uid> into sessionStorage after
  // its first call to /rest/v1/partners. We piggy-back on that cache; if the
  // sidebar hasn't run yet (e.g. our share button is clicked before nav
  // finishes hydrating), the fallback is "no ref added" which is fine — a
  // clean URL still works.
  function projectRef() {
    var url = (window.LYMX_CONFIG && window.LYMX_CONFIG.SUPABASE_URL) || '';
    var m = url.match(/https:\/\/([^.]+)\.supabase\.co/i);
    return m ? m[1] : null;
  }
  function readToken() {
    var ref = projectRef();
    if (!ref) return null;
    var raw = localStorage.getItem('sb-' + ref + '-auth-token');
    if (!raw) return null;
    // JSON.parse genuinely can throw on corrupt cache; return null on bad data
    // so callers fall through to "anonymous" share behavior instead of crashing.
    var obj;
    try { obj = JSON.parse(raw); } catch (e) { return null; }
    return (obj && obj.access_token)
      || (obj && obj.currentSession && obj.currentSession.access_token)
      || null;
  }
  function decodeJwt(tok) {
    var parts = (tok || '').split('.');
    if (parts.length !== 3) return null;
    // atob throws on invalid base64; JSON.parse throws on bad payload. Both
    // outcomes are legitimate runtime failures (e.g. token rotated mid-load).
    try {
      return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    } catch (e) { return null; }
  }
  function getMyPartnerCode() {
    var tok = readToken();
    if (!tok) return null;
    var p = decodeJwt(tok);
    var uid = p && p.sub;
    if (!uid) return null;
    var cached = sessionStorage.getItem('LYMX_partner_code_' + uid);
    if (!cached || cached === '__none__') return null;
    // Format guard — partner codes are like "P-000001"; if anything weird
    // is in the cache, don't decorate the URL with garbage.
    if (!/^P-\d{4,}$/i.test(cached)) return null;
    return cached;
  }

  // ----- utility: derive the share TITLE from page topic --------------------
  // Order: explicit override → og:title → first h1 → document.title cleaned.
  function pageShareTitle() {
    var override = document.body && document.body.getAttribute('data-share-title');
    if (override && override.trim()) return override.trim();

    var og = document.querySelector('meta[property="og:title"]');
    if (og && og.content && og.content.trim()) return og.content.trim();

    var h1 = document.querySelector('h1');
    if (h1) {
      var t = (h1.textContent || '').replace(/\s+/g, ' ').trim();
      // Strip "LYMX ★" type one-word/two-word brand-only headings — they
      // don't tell the recipient anything about the page.
      if (t && t.length > 2 && !/^lymx\s*[★*]?$/i.test(t)) return t;
    }

    var dt = (document.title || '').replace(/\s+/g, ' ').trim();
    // Remove the common " — LYMX Power" / " · LYMX" suffix patterns so the
    // share preview reads naturally.
    dt = dt.replace(/\s*[—·|-]\s*LYMX(\s+Power)?\s*$/i, '').trim();
    if (dt) return dt;

    return 'LYMX';
  }

  // ----- utility: build the URL to share -----------------------------------
  function pageShareUrl() {
    // URL constructor throws on malformed location.href; on the off-chance
    // that happens (it shouldn't on any served HTTPS page), return the raw
    // href unmodified so the share still works.
    var u;
    try { u = new URL(location.href); } catch (e) { return location.href; }
    // If URL already has ?ref=, keep it (honor the attribution chain).
    // Otherwise, decorate with the signed-in user's partner code if any.
    if (!u.searchParams.has('ref')) {
      var code = getMyPartnerCode();
      if (code) u.searchParams.set('ref', code);
    }
    return u.toString();
  }

  // ----- utility: small toast for clipboard feedback ------------------------
  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:80px;transform:translateX(-50%);'
      + 'background:#0e1116;color:#fff;padding:10px 16px;border-radius:999px;'
      + 'font-size:13px;font-weight:600;z-index:100000;box-shadow:0 8px 24px rgba(14,17,22,.3);'
      + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;'
      + 'opacity:0;transition:opacity .15s';
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.style.opacity = '1'; });
    setTimeout(function () {
      t.style.opacity = '0';
      // Element.remove() does not throw when called on an attached node we
      // just inserted; no try/catch needed.
      setTimeout(function () { if (t && t.parentNode) t.parentNode.removeChild(t); }, 200);
    }, 1800);
  }

  // ----- the actual share action -------------------------------------------
  async function doShare(opts) {
    var title = (opts && opts.title) || pageShareTitle();
    var url   = (opts && opts.url)   || pageShareUrl();
    // 2026-05-26 — per Kenny: "use the topic of that page as subject".
    // The page topic is the share TITLE; the URL is appended by the share
    // target naturally. Don't pre-concatenate the URL into the title.
    var shareData = { title: title, text: title, url: url };

    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return; // success on native share sheet
      } catch (e) {
        // AbortError = user cancelled the native share sheet on purpose.
        // Anything else = the share API is broken on this device — fall
        // through to clipboard so the share isn't lost. Both legitimate.
        if (e && e.name === 'AbortError') return;
        console.warn('[lymx-share] navigator.share failed, falling back', e);
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(url);
        toast('Link copied — share it anywhere');
        return;
      } catch (e) {
        // clipboard.writeText rejects when the page lacks user activation /
        // clipboard permission (older browsers, some embed contexts). Real
        // failure mode; fall through to the prompt fallback so the share
        // still completes.
        console.warn('[lymx-share] clipboard write failed', e);
      }
    }
    // Last-resort: visible prompt the user can copy from manually. window.prompt
    // returns null on cancel but does not throw.
    window.prompt('Copy this link to share:', url);
  }

  // Expose programmatic API for pages that want to wire their own buttons.
  // e.g. a hero CTA on /what-is-lymx can do: onclick="LYMX_share()".
  window.LYMX_share = doShare;

  // ----- the floating "Share" pill -----------------------------------------
  // Bottom-LEFT so it doesn't collide with the Help & Feedback pill
  // (bottom-right) injected by lymx-feedback.js. 12px from the corner so
  // both pills line up visually.
  function injectPill() {
    if (!document.body) { return setTimeout(injectPill, 50); }
    if (document.getElementById('lymx-share-pill')) return;

    // Per-page opt-out (mirrors lymx-feedback's data-no-fb-btn).
    if (document.body.getAttribute('data-no-share-btn') === 'true') return;

    // Auto-opt-out pages where sharing is meaningless / confusing:
    //   - login.html — sharing a login form leaks no value
    //   - the OAuth round-trip helpers — short-lived intermediate pages
    var path = (location.pathname || '').toLowerCase();
    var SUPPRESS = [
      '/login.html', '/login',
      '/google-oauth-done.html'
    ];
    if (SUPPRESS.some(function (p) { return path === p || path.endsWith(p); })) return;

    var css = ''
      + '#lymx-share-pill{position:fixed;left:18px;bottom:18px;z-index:99998;'
      +   'background:#0a84ff;color:#fff;border:0;padding:11px 17px;border-radius:999px;'
      +   'font-weight:700;font-size:13.5px;cursor:pointer;'
      +   'box-shadow:0 8px 24px rgba(10,132,255,.30);'
      +   'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;'
      +   'display:flex;align-items:center;gap:7px;transition:.15s}'
      + '#lymx-share-pill:hover{background:#0070e0;transform:translateY(-1px);'
      +   'box-shadow:0 10px 28px rgba(10,132,255,.40)}'
      + '#lymx-share-pill:active{transform:translateY(0)}'
      // Narrow screens — keep the pill compact and 12px from the corner so
      // the Help & Feedback pill on the right has room. iOS home-indicator
      // safe-area-inset already accounted for via bottom: 18px which sits
      // above the indicator on standard devices.
      + '@media (max-width:520px){'
      +   '#lymx-share-pill{left:12px;bottom:12px;padding:10px 14px;font-size:12.5px}'
      + '}'
      // 2026-05-31 #2 — at >=1101px the fixed left sidebar (.lymx-sb) occupies the
      // bottom-left corner, so the bottom-left share pill floated over its "Sign out"
      // button. Shift the pill to the right of the sidebar ONLY when the sidebar is
      // actually present (body.lymx-sb-pushed is added by lymx-sidebar.js), so the
      // pill never covers Sign out and pages without the sidebar are unaffected.
      + '@media (min-width:1101px){body.lymx-sb-pushed #lymx-share-pill{left:272px}}';
    var st = document.createElement('style');
    st.id = 'lymx-share-css';
    st.textContent = css;
    document.head.appendChild(st);

    var btn = document.createElement('button');
    btn.id = 'lymx-share-pill';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Share this page');
    btn.innerHTML = '<span aria-hidden="true">↗</span><span>Share</span>';
    btn.addEventListener('click', function () { doShare(); });
    document.body.appendChild(btn);
  }

  // Wait for DOM body, then inject. We deliberately don't wait for
  // lymx-sidebar to finish hydrating the partner_code cache  — if the user
  // shares before the cache lands, the URL goes out without ?ref=. That's
  // strictly better than blocking the button on a network round-trip.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectPill);
  } else {
    injectPill();
  }
})();
