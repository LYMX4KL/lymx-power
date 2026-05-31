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
  // 2026-05-31 #65/#69 — deterministic share dialog. navigator.share is flaky
  // on desktop (frequently rejects or does nothing), which is exactly why
  // "Share does nothing" kept getting reported across Share Hub and business
  // profiles. On touch devices the native sheet is still the best UX; on
  // desktop (and any non-native case) we show an explicit dialog with
  // per-network links + a Copy button, so a click ALWAYS does something visible.
  function shareNetworks(url, text, title) {
    var u = encodeURIComponent(url), t = encodeURIComponent(text || title || ''), tt = encodeURIComponent(title || 'LYMX');
    return [
      { label: 'X / Twitter', color: '#0f1419', href: 'https://twitter.com/intent/tweet?text=' + t + '&url=' + u },
      { label: 'Facebook',    color: '#1877f2', href: 'https://www.facebook.com/sharer/sharer.php?u=' + u },
      { label: 'WhatsApp',    color: '#25d366', href: 'https://wa.me/?text=' + t + '%20' + u },
      { label: 'LinkedIn',    color: '#0a66c2', href: 'https://www.linkedin.com/sharing/share-offsite/?url=' + u },
      { label: 'Email',       color: '#5b6472', href: 'mailto:?subject=' + tt + '&body=' + t + '%0A%0A' + u }
    ];
  }
  function copyShareLink(url) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(
        function () { toast('Link copied — paste it anywhere'); },
        function () { window.prompt('Copy this link to share:', url); });
    } else { window.prompt('Copy this link to share:', url); }
  }
  function openShareDialog(opts) {
    opts = opts || {};
    var url = opts.url || pageShareUrl();
    var title = opts.title || pageShareTitle();
    var text = opts.text || title;
    var prev = document.getElementById('lymxShareOverlay'); if (prev) prev.remove();
    var ov = document.createElement('div');
    ov.id = 'lymxShareOverlay';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Share');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(8,12,20,.5);z-index:100001;display:flex;align-items:center;justify-content:center;padding:20px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif';
    var nets = shareNetworks(url, text, title).map(function (n) {
      return '<a href="' + n.href + '" target="_blank" rel="noopener" class="lymx-share-net" style="display:flex;align-items:center;gap:10px;padding:11px 14px;border:1px solid #e6e8ec;border-radius:10px;text-decoration:none;color:#0e1116;font-weight:700;font-size:14px;background:#fff">' +
        '<span style="width:9px;height:9px;border-radius:50%;background:' + n.color + ';flex:0 0 auto"></span>' + n.label + '</a>';
    }).join('');
    ov.innerHTML =
      '<div style="background:#fff;border-radius:16px;padding:20px;width:380px;max-width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3)">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">' +
          '<h3 style="margin:0;font-size:17px;font-weight:800;color:#0e1116">Share</h3>' +
          '<button type="button" id="lymxShareClose" aria-label="Close" style="appearance:none;border:0;background:#f1f3f6;width:30px;height:30px;border-radius:8px;font-size:17px;cursor:pointer;color:#5b6472;line-height:1">&times;</button>' +
        '</div>' +
        '<p style="margin:0 0 14px;font-size:12.5px;color:#5b6472">Pick where to share, or copy the link.</p>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">' + nets + '</div>' +
        '<div style="display:flex;gap:8px;align-items:center">' +
          '<input type="text" readonly id="lymxShareUrlField" value="' + String(url).replace(/"/g, '&quot;') + '" style="flex:1;min-width:0;padding:10px 11px;border:1px solid #e6e8ec;border-radius:9px;font:inherit;font-size:12.5px;background:#f6f7f9;color:#0e1116" />' +
          '<button type="button" id="lymxShareCopyBtn" style="appearance:none;border:0;background:#0e1116;color:#fff;padding:10px 16px;border-radius:9px;cursor:pointer;font:inherit;font-size:13.5px;font-weight:700;white-space:nowrap">Copy link</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    var close = function () { ov.remove(); document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.getElementById('lymxShareClose').addEventListener('click', close);
    document.getElementById('lymxShareCopyBtn').addEventListener('click', function () { copyShareLink(url); });
    ov.querySelectorAll('.lymx-share-net').forEach(function (a) { a.addEventListener('click', function () { setTimeout(close, 120); }); });
    document.addEventListener('keydown', onKey);
  }

  async function doShare(opts) {
    var title = (opts && opts.title) || pageShareTitle();
    var url   = (opts && opts.url)   || pageShareUrl();
    var text  = (opts && opts.text)  || title;
    var coarse = false;
    try { coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { coarse = false; }
    // Touch devices: native sheet is the best UX. If missing or it fails for
    // any reason other than a deliberate cancel, fall through to the dialog.
    if (typeof navigator.share === 'function' && coarse) {
      try { await navigator.share({ title: title, text: text, url: url }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    // Desktop / non-native: deterministic dialog — always visible and working.
    openShareDialog({ title: title, url: url, text: text });
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
