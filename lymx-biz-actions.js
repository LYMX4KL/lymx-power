// =============================================================================
// LYMX biz-page action wiring — Save + Share with real DB persistence.
// =============================================================================
// Loaded by lymx-app.js on every page. Activates ONLY on /biz-*.html pages.
//
// Wires:
//   - #saveBtn — persists to public.saved_businesses (RLS-scoped to auth.uid()).
//                Reads the user's saved state on mount so the button shows the
//                correct initial label/color. Click toggles INSERT / DELETE.
//                Root-cause fix for T-6ABF51 — was a UI-only toggle that reset
//                every page load and never told the backend.
//   - #shareBtn — keeps the existing navigator.share -> clipboard -> toast
//                 fallback chain but standardizes the implementation so every
//                 biz page behaves identically. Centralizes T-B78E5A.
//
// Falls back gracefully when the user is signed out (Save becomes a sign-in
// nudge, Share still works via clipboard). Never throws.
//
// Idempotent — checks __LYMX_BIZ_ACTIONS_LOADED__.
// =============================================================================
(function () {
  if (window.__LYMX_BIZ_ACTIONS_LOADED__) return;
  window.__LYMX_BIZ_ACTIONS_LOADED__ = true;

  // ----- Page-applicability gate ---------------------------------------------
  // Only run on biz profile pages. The convention is /biz-<slug>.html or
  // /biz-<slug> (Netlify strips .html). Excludes admin/dashboard pages that
  // happen to start with "biz-" like /biz-dashboard.html, /biz-signup.html,
  // /biz-profile.html, /biz-conversations.html, etc.
  function isBizProfilePage() {
    var path = (location.pathname || '').toLowerCase();
    if (!/^\/biz-/.test(path)) return false;
    // Skip the non-profile pages that share the prefix
    var notProfile = [
      'biz-dashboard', 'biz-signup', 'biz-profile', 'biz-conversations',
      'biz-analytics', 'biz-cashflow', 'biz-customer-data', 'biz-data-export',
      'biz-dispute-handling', 'biz-do-nothing', 'biz-faq'
    ];
    return !notProfile.some(function (p) { return path.indexOf('/' + p) === 0; });
  }

  // ----- Slug detection ------------------------------------------------------
  // /biz-brew-and-bean.html -> "brew-and-bean"
  // /biz-brew-and-bean      -> "brew-and-bean"
  function getBizSlug() {
    var path = (location.pathname || '').toLowerCase();
    var m = path.match(/^\/biz-([a-z0-9-]+?)(?:\.html)?$/);
    return m ? m[1] : null;
  }

  // ----- Display name + emoji from the page itself ---------------------------
  // Pulled from the <h1> and the first emoji-looking element. We persist these
  // alongside the slug so "Saved" lists don't have to re-fetch every biz to
  // show its name. (Matches the schema in migration 030.)
  function getBizDisplay() {
    var h1 = document.querySelector('h1');
    var name = h1 ? h1.textContent.replace(/\s+/g, ' ').trim() : (document.title || '').split('·')[0].trim();
    // Heuristic: first single-character "emoji" inside h1 or the brand
    var emoji = '';
    var matches = (h1 ? h1.textContent : '').match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    if (matches) emoji = matches[0];
    return { name: name, emoji: emoji };
  }

  // ----- Supabase config + token (read directly, no SDK dep) -----------------
  function getCfg() { return window.LYMX_CONFIG; }
  function readToken() {
    try {
      var cfg = getCfg();
      if (!cfg || !cfg.SUPABASE_URL) return null;
      var m = cfg.SUPABASE_URL.match(/https:\/\/([^.]+)\.supabase\.co/i);
      if (!m) return null;
      var raw = localStorage.getItem('sb-' + m[1] + '-auth-token');
      if (!raw) return null;
      var obj = JSON.parse(raw);
      return (obj && obj.access_token)
          || (obj && obj.currentSession && obj.currentSession.access_token)
          || null;
    } catch (e) { return null; }
  }

  // ----- Toast (shared with existing inline UI) ------------------------------
  function toast(msg, ok) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:30px;transform:translateX(-50%);background:' + (ok ? '#13a26b' : '#0e1116') + ';color:#fff;padding:12px 20px;border-radius:12px;font-weight:600;font-size:14px;box-shadow:0 8px 24px rgba(0,0,0,.25);z-index:10000';
    document.body.appendChild(t);
    setTimeout(function () { t.style.transition = '.4s'; t.style.opacity = '0'; t.style.transform = 'translateX(-50%) translateY(10px)'; }, 1800);
    setTimeout(function () { t.remove(); }, 2300);
  }

  // ----- Save button: persisted state ----------------------------------------
  function setSavedUi(btn, isSaved) {
    if (!btn) return;
    btn.dataset.saved = isSaved ? '1' : '0';
    btn.textContent = isSaved ? '♥ Saved' : '♡ Save';
    btn.style.color = isSaved ? '#e0245e' : '';
  }

  async function loadSavedState(slug, btn) {
    var cfg = getCfg(); var tok = readToken();
    if (!cfg || !tok) { setSavedUi(btn, false); return; } // signed-out users see the empty heart
    try {
      var r = await fetch(cfg.SUPABASE_URL + '/rest/v1/saved_businesses?business_slug=eq.' + encodeURIComponent(slug) + '&select=id&limit=1', {
        headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + tok }
      });
      if (!r.ok) { setSavedUi(btn, false); return; }
      var rows = await r.json();
      setSavedUi(btn, !!(rows && rows.length));
    } catch (e) {
      console.warn('[lymx-biz-actions] loadSavedState', e);
      setSavedUi(btn, false);
    }
  }

  function bindSaveButton(btn, slug, display) {
    if (!btn || btn.dataset.lymxSaveWired === '1') return;
    btn.dataset.lymxSaveWired = '1';
    // Override any inline toggleSave the page may have set — we want DB-backed.
    // The button's HTML onclick="toggleSave(this)" will still call window.toggleSave,
    // so we replace that with the persisted version.
    window.toggleSave = async function (b) {
      b = b || btn;
      var cfg = getCfg(); var tok = readToken();
      if (!cfg || !tok) {
        toast('Sign in to save businesses to your favorites.');
        // After 1s, route to sign-in with a return URL so they land back here
        setTimeout(function () { location.href = '/login.html?return=' + encodeURIComponent(location.pathname); }, 900);
        return;
      }
      var isSaved = b.dataset.saved === '1';
      try {
        if (isSaved) {
          var dr = await fetch(cfg.SUPABASE_URL + '/rest/v1/saved_businesses?business_slug=eq.' + encodeURIComponent(slug), {
            method: 'DELETE',
            headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + tok, Prefer: 'return=minimal' }
          });
          if (!dr.ok) throw new Error(await dr.text());
          setSavedUi(b, false);
          toast('Removed from saved');
        } else {
          // Need the user's uid for the INSERT; pull from the JWT payload
          var parts = tok.split('.'); var uid = null;
          try { uid = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))).sub; } catch (e) {}
          if (!uid) throw new Error('no uid in session');
          var ir = await fetch(cfg.SUPABASE_URL + '/rest/v1/saved_businesses', {
            method: 'POST',
            headers: {
              apikey: cfg.SUPABASE_ANON_KEY,
              Authorization: 'Bearer ' + tok,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal,resolution=merge-duplicates'
            },
            body: JSON.stringify({
              user_id: uid,
              business_slug: slug,
              business_name: display.name || slug,
              business_emoji: display.emoji || null
            })
          });
          if (!ir.ok) throw new Error(await ir.text());
          setSavedUi(b, true);
          toast('Saved to your favorites', true);
        }
      } catch (e) {
        console.warn('[lymx-biz-actions] toggleSave failed', e);
        toast('Could not update saved — try again in a moment.');
      }
    };
  }

  // ----- Share button --------------------------------------------------------
  function bindShareButton(btn) {
    if (!btn || btn.dataset.lymxShareWired === '1') return;
    btn.dataset.lymxShareWired = '1';
    window.shareBiz = async function (b) {
      b = b || btn;
      var url = location.href;
      var h1 = document.querySelector('h1');
      var title = (h1 && h1.textContent.trim()) || document.title || 'LYMX business';
      // Try native share first — best mobile UX
      if (navigator.share) {
        try { await navigator.share({ title: title, url: url }); return; }
        catch (e) { /* user cancelled or permission denied — fall through to clipboard */ }
      }
      // Clipboard fallback
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(url); toast('Link copied to clipboard', true); return; }
        catch (e) { /* fall through */ }
      }
      // Last-resort textarea select+execCommand
      try {
        var ta = document.createElement('textarea');
        ta.value = url; ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        toast('Link copied', true);
      } catch (e) {
        toast('Share: ' + url);
      }
    };
  }

  // ----- Boot ----------------------------------------------------------------
  function boot() {
    if (!isBizProfilePage()) return;
    var slug = getBizSlug();
    if (!slug) return;
    var display = getBizDisplay();

    var saveBtn = document.getElementById('saveBtn');
    var shareBtn = document.getElementById('shareBtn');
    if (saveBtn) {
      bindSaveButton(saveBtn, slug, display);
      loadSavedState(slug, saveBtn);
    }
    if (shareBtn) {
      bindShareButton(shareBtn);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    // The page's inline scripts have already run and set window.toggleSave.
    // Boot synchronously so we override before the user can click.
    boot();
  }
})();
