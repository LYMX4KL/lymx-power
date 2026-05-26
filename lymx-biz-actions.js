// =============================================================================
// LYMX biz-page action wiring — Save + Share + Reserve with real DB persistence.
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
//   - Reserve a Table — POST to public.table_reservations (2026-05-25 #026db35c).
//
// 2026-05-26 (migration 092 / Phase 0 of biz-onboarding roadmap):
//   Added a single `loadBizMeta(slug)` lookup that fetches `id + demo_only`
//   once per page and caches the Promise. Save / Reserve / Reviews all `await`
//   it before writing. When `demo_only=true`, a PREVIEW banner is prepended to
//   the page and every transactional action refuses with a clear toast. This
//   replaces the old slug→id-only reservation lookup so the demo-only path
//   shares the same cache as the other actions.
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
  function isBizProfilePage() {
    var path = (location.pathname || '').toLowerCase();
    if (!/^\/biz-/.test(path)) return false;
    var notProfile = [
      'biz-dashboard', 'biz-signup', 'biz-profile', 'biz-conversations',
      'biz-analytics', 'biz-cashflow', 'biz-customer-data', 'biz-data-export',
      'biz-dispute-handling', 'biz-do-nothing', 'biz-faq'
    ];
    return !notProfile.some(function (p) { return path.indexOf('/' + p) === 0; });
  }

  // ----- Slug detection ------------------------------------------------------
  function getBizSlug() {
    var path = (location.pathname || '').toLowerCase();
    var m = path.match(/^\/biz-([a-z0-9-]+?)(?:\.html)?$/);
    return m ? m[1] : null;
  }

  // ----- Display name + emoji from the page itself ---------------------------
  function getBizDisplay() {
    var h1 = document.querySelector('h1');
    var name = h1 ? h1.textContent.replace(/\s+/g, ' ').trim() : (document.title || '').split('·')[0].trim();
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
    } catch (e) {
      console.warn('[lymx-biz-actions] readToken failed', e);
      return null;
    }
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

  // ----- Tiny HTML escape ----------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ----- Business metadata cache (id + demo_only) ----------------------------
  // Migration 092 (2026-05-26) added `demo_only` to public.businesses so the
  // static visual-prop pages (biz-brew-and-bean.html / biz-oakline-kitchen.html)
  // can have real rows without polluting real merchant data. loadBizMeta
  // returns {id, demo_only, display_name}, cached for the page lifetime.
  // Save / Reserve / Reviews all await it and refuse to write on demo rows.
  // Window-scoped so lymx-reviews.js can reuse the cache.
  if (!window.LymxBizActions) window.LymxBizActions = {};
  window.LymxBizActions.loadBizMeta = function (slug) {
    if (window.__LYMX_BIZ_META_PROMISE) return window.__LYMX_BIZ_META_PROMISE;
    var cfg = getCfg();
    if (!cfg || !slug) {
      window.__LYMX_BIZ_META_PROMISE = Promise.resolve(null);
      return window.__LYMX_BIZ_META_PROMISE;
    }
    window.__LYMX_BIZ_META_PROMISE = (async function () {
      try {
        // Migration 094: route through the SECURITY DEFINER RPC fn_biz_public_meta
        // instead of a direct table SELECT. The anon role cannot read businesses
        // directly (RLS denies, returns 401) — see 094 root-cause comment.
        var r = await fetch(
          cfg.SUPABASE_URL + '/rest/v1/rpc/fn_biz_public_meta',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: cfg.SUPABASE_ANON_KEY,
              Authorization: 'Bearer ' + cfg.SUPABASE_ANON_KEY
            },
            body: JSON.stringify({ p_slug: slug })
          }
        );
        if (!r.ok) {
          console.warn('[lymx-biz-actions] loadBizMeta', r.status);
          return null;
        }
        var rows = await r.json();
        return (Array.isArray(rows) && rows[0]) || (rows && rows.id ? rows : null);
      } catch (e) {
        console.warn('[lymx-biz-actions] loadBizMeta failed', e);
        return null;
      }
    })();
    return window.__LYMX_BIZ_META_PROMISE;
  };
  function loadBizMeta(slug) { return window.LymxBizActions.loadBizMeta(slug); }

  // ----- Demo banner injection (migration 092) -------------------------------
  function injectDemoBanner(displayName) {
    if (document.getElementById('lymxBizDemoBanner')) return;
    var banner = document.createElement('div');
    banner.id = 'lymxBizDemoBanner';
    banner.style.cssText = ''
      + 'position:relative;z-index:60;'
      + 'background:linear-gradient(135deg,#fff4d6,#ffe9a8);'
      + 'border-bottom:1px solid #d4a017;'
      + 'color:#5a3e00;'
      + 'font-family:inherit;font-size:14px;font-weight:600;'
      + 'padding:10px 18px;text-align:center;line-height:1.5;';
    banner.innerHTML = ''
      + '<span style="font-size:16px">⚠️</span> '
      + '<strong>PREVIEW</strong> — '
      + esc(displayName || 'this listing')
      + ' is a sample page used to show how a real business looks on LYMX. '
      + 'It is not a real merchant. '
      + '<a href="biz-signup.html" style="color:#0a84ff;text-decoration:underline;font-weight:700">'
      + 'Sign up your real business →</a>';
    if (document.body.firstChild) {
      document.body.insertBefore(banner, document.body.firstChild);
    } else {
      document.body.appendChild(banner);
    }
    document.body.dataset.bizDemo = '1';
  }

  function demoBlockedToast() {
    toast('This is a preview business — Save / Reserve / Review only work on real LYMX merchants. Sign up your real business at /biz-signup.html.');
  }
  // Expose for lymx-reviews.js
  window.LymxBizActions.demoBlockedToast = demoBlockedToast;

  // ----- Save button: persisted state ----------------------------------------
  function setSavedUi(btn, isSaved) {
    if (!btn) return;
    btn.dataset.saved = isSaved ? '1' : '0';
    btn.textContent = isSaved ? '♥ Saved' : '♡ Save';
    btn.style.color = isSaved ? '#e0245e' : '';
  }

  async function loadSavedState(slug, btn) {
    var cfg = getCfg(); var tok = readToken();
    if (!cfg || !tok) { setSavedUi(btn, false); return; }
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
    window.toggleSave = async function (b) {
      b = b || btn;
      var cfg = getCfg(); var tok = readToken();
      if (!cfg || !tok) {
        toast('Sign in to save businesses to your favorites.');
        setTimeout(function () { location.href = '/login.html?return=' + encodeURIComponent(location.pathname); }, 900);
        return;
      }
      // Demo-biz guard (migration 092)
      var meta = await loadBizMeta(slug);
      if (meta && meta.demo_only) { demoBlockedToast(); return; }
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
          var parts = tok.split('.'); var uid = null;
          try {
            uid = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))).sub;
          } catch (e) {
            console.warn('[lymx-biz-actions] toggleSave JWT parse failed', e);
          }
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
      if (navigator.share) {
        try { await navigator.share({ title: title, url: url }); return; }
        catch (e) { /* user cancelled or permission denied — fall through to clipboard */ }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(url); toast('Link copied to clipboard', true); return; }
        catch (e) { /* fall through */ }
      }
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

    // Kick off demo_only / id lookup once for the whole page. If demo_only,
    // inject the PREVIEW banner. Don't await — handlers await independently.
    loadBizMeta(slug).then(function (meta) {
      if (meta && meta.demo_only) {
        injectDemoBanner(meta.display_name || display.name || slug);
      }
    });

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

  // ----- Reserve a Table (2026-05-25 #026db35c) ------------------------------
  function bindReservationButton(btn, slug, display) {
    if (!btn || btn.dataset.lymxResWired === '1') return;
    btn.dataset.lymxResWired = '1';
    window.submitReservation = async function (b) {
      b = b || btn;
      var cfg = getCfg(); if (!cfg) { toast('Config not loaded'); return; }
      // Resolve business meta from slug (shared cache via loadBizMeta).
      // Returns id (for INSERT) and demo_only (for the guard).
      var meta = await loadBizMeta(slug);
      if (!meta) { toast('Business not found.'); return; }
      if (meta.demo_only) { demoBlockedToast(); return; }
      var bizId = meta.id;
      b.dataset.businessId = bizId;

      var selectedDate = (document.querySelector('.reserve-card .ip.sel[data-res-date]') || {}).dataset && (document.querySelector('.reserve-card .ip.sel[data-res-date]') || {}).dataset.resDate || '';
      var selectedTime = (document.querySelector('.reserve-card .ip.sel[data-res-time]') || {}).dataset && (document.querySelector('.reserve-card .ip.sel[data-res-time]') || {}).dataset.resTime || '';
      var party = parseInt(b.dataset.partySize || '2', 10);
      if (!selectedDate || !selectedTime) { toast('Pick a date and time'); return; }

      var dt;
      try { dt = new Date(selectedDate + 'T' + selectedTime); } catch (e) { dt = null; }
      if (!dt || isNaN(dt.getTime())) { toast('Invalid date/time'); return; }

      var tok = readToken();
      var bookerName = '', bookerEmail = '', uid = null;
      if (tok) {
        try {
          var payload = JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
          uid = payload.sub;
          bookerEmail = payload.email || '';
          bookerName = (payload.user_metadata && (payload.user_metadata.full_name || payload.user_metadata.name)) || bookerEmail.split('@')[0] || '';
        } catch (e) {
          // JWT payload occasionally has padding/encoding edges that throw.
          // Non-fatal: the prompt() fallbacks below collect the missing fields.
          console.warn('[lymx-biz-actions] reserve: JWT payload parse failed; using prompt fallback', e);
        }
      }
      if (!bookerName) {
        bookerName = prompt('Your name for the reservation:', '') || '';
        if (!bookerName) return;
      }
      if (!bookerEmail) {
        bookerEmail = prompt('Email for the confirmation:', '') || '';
        if (!bookerEmail) return;
      }

      b.disabled = true;
      var origText = b.textContent;
      b.textContent = 'Submitting...';

      try {
        var ir = await fetch(cfg.SUPABASE_URL + '/rest/v1/table_reservations', {
          method: 'POST',
          headers: {
            apikey: cfg.SUPABASE_ANON_KEY,
            Authorization: tok ? ('Bearer ' + tok) : ('Bearer ' + cfg.SUPABASE_ANON_KEY),
            'Content-Type': 'application/json',
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({
            business_id:   bizId,
            business_slug: slug,
            business_name: display.name || slug,
            user_id:       uid,
            booker_name:   bookerName,
            booker_email:  bookerEmail,
            party_size:    party,
            requested_for: dt.toISOString(),
            status:        'pending'
          })
        });
        if (!ir.ok) throw new Error((await ir.text()).slice(0, 200));
        toast('Reservation request sent — ' + (display.name || 'the business') + ' will confirm shortly.', true);
        b.textContent = 'Request sent';
      } catch (e) {
        console.warn('[lymx-biz-actions] submitReservation failed', e);
        toast('Could not send — try again in a moment.');
        b.disabled = false;
        b.textContent = origText;
      }
    };
  }

  function bootExt() {
    if (!isBizProfilePage()) return;
    var slug = getBizSlug();
    if (!slug) return;
    var display = getBizDisplay();
    var resBtn = document.querySelector('.reserve-card .btn-res');
    if (resBtn) bindReservationButton(resBtn, slug, display);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot(); bootExt(); });
  } else {
    boot();
    bootExt();
  }
})();
