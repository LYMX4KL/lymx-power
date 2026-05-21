// =============================================================================
// LYMX i18n — site-wide translation engine
// =============================================================================
// Drop into any page (preferably auto-loaded by lymx-app.js):
//
//     <script src="lymx-i18n.js" defer></script>
//
// SUPPORTED LOCALES:
//   en     — English (source of truth, default)
//   es     — Español (Spanish)
//   zh-CN  — 简体中文 (Simplified Chinese)
//   zh-TW  — 繁體中文 (Traditional Chinese)
//
// HOW TO MARK ANY HTML ELEMENT AS TRANSLATABLE:
//
//   <button data-i18n="action.send">Send</button>
//   <h1 data-i18n="page.dashboard.title">Dashboard</h1>
//   <input data-i18n-placeholder="form.email_placeholder" placeholder="Email">
//   <a data-i18n-title="action.sign_in" title="Sign in">→</a>
//
// The key is looked up in lymx-i18n-<locale>.json (loaded lazily). If a key
// is missing in the current locale, the engine falls back to English. If the
// key is missing in English too, the element's existing textContent is kept
// (no breakage).
//
// LOCALE RESOLUTION (first match wins):
//   1. localStorage.lymx_locale  — user's explicit choice
//   2. navigator.language        — browser preference (zh-CN / zh-TW / es-MX → mapped to supported)
//   3. 'en'                      — default
//
// LANGUAGE TOGGLE:
//   A floating "🌐 EN ▾" chip is auto-injected at top-right (collision-aware
//   with lymx-nav's Sign In chip). Clicking opens a small menu with all 4
//   languages. Selecting one persists to localStorage + re-translates the
//   page WITHOUT a full reload (smooth UX).
//
// IDEMPOTENT: safe to load on every page. Won't re-init if already loaded.
// =============================================================================

(function () {
  if (window.__LYMX_I18N_LOADED__) return;
  window.__LYMX_I18N_LOADED__ = true;

  var SUPPORTED = ['en', 'es', 'zh-CN', 'zh-TW', 'ko', 'ja'];
  var DEFAULT_LOCALE = 'en';
  var LABELS = {
    'en':    'EN',
    'es':    'ES',
    'zh-CN': '简',
    'zh-TW': '繁',
    'ko':    '한',
    'ja':    'あ'
  };
  var FULL_NAMES = {
    'en':    'English',
    'es':    'Español',
    'zh-CN': '简体中文',
    'zh-TW': '繁體中文',
    'ko':    '한국어',
    'ja':    '日本語'
  };

  // ---------- Locale resolution ------------------------------------------
  function detectBrowserLocale() {
    var langs = (navigator.languages && navigator.languages.length)
                  ? navigator.languages
                  : [navigator.language || 'en'];
    for (var i = 0; i < langs.length; i++) {
      var lang = (langs[i] || '').trim();
      if (!lang) continue;
      var lower = lang.toLowerCase();
      // Exact match
      for (var j = 0; j < SUPPORTED.length; j++) {
        if (SUPPORTED[j].toLowerCase() === lower) return SUPPORTED[j];
      }
      // Special handling for Chinese variants
      if (lower === 'zh' || lower === 'zh-hans' || lower === 'zh-cn' || lower === 'zh-sg') return 'zh-CN';
      if (lower === 'zh-hant' || lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-mo') return 'zh-TW';
      // Language-only prefix
      var prefix = lower.split('-')[0];
      for (var k = 0; k < SUPPORTED.length; k++) {
        if (SUPPORTED[k].toLowerCase().split('-')[0] === prefix) return SUPPORTED[k];
      }
    }
    return DEFAULT_LOCALE;
  }

  function getStoredLocale() {
    try {
      var v = localStorage.getItem('lymx_locale');
      if (v && SUPPORTED.indexOf(v) !== -1) return v;
    } catch (e) {}
    return null;
  }

  function setStoredLocale(loc) {
    try { localStorage.setItem('lymx_locale', loc); } catch (e) {}
  }

  function resolveLocale() {
    return getStoredLocale() || detectBrowserLocale() || DEFAULT_LOCALE;
  }

  // ---------- Translation dictionaries (loaded lazily) -------------------
  var dicts = {};         // { 'en': {...}, 'es': {...}, ... }
  var loadPromises = {};  // { 'en': Promise, ... }

  function loadDict(locale) {
    if (dicts[locale]) return Promise.resolve(dicts[locale]);
    if (loadPromises[locale]) return loadPromises[locale];
    var url = 'lymx-i18n-' + locale + '.json?v=' + (window.__LYMX_I18N_CACHEBUST || 1);
    loadPromises[locale] = fetch(url, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('i18n load ' + locale + ' ' + r.status);
        return r.json();
      })
      .then(function (j) { dicts[locale] = j; return j; })
      .catch(function (e) { console.warn('[i18n]', locale, 'load failed:', e); dicts[locale] = {}; return {}; });
    return loadPromises[locale];
  }

  function lookup(key, locale) {
    var d = dicts[locale];
    if (d && Object.prototype.hasOwnProperty.call(d, key)) return d[key];
    return null;
  }

  // ---------- DOM application -------------------------------------------
  function applyToElement(el, locale) {
    var key = el.getAttribute('data-i18n');
    if (key) {
      var v = lookup(key, locale) || lookup(key, 'en');
      if (v != null) el.textContent = v;
    }
    var keyP = el.getAttribute('data-i18n-placeholder');
    if (keyP) {
      var vp = lookup(keyP, locale) || lookup(keyP, 'en');
      if (vp != null) el.setAttribute('placeholder', vp);
    }
    var keyT = el.getAttribute('data-i18n-title');
    if (keyT) {
      var vt = lookup(keyT, locale) || lookup(keyT, 'en');
      if (vt != null) el.setAttribute('title', vt);
    }
    var keyA = el.getAttribute('data-i18n-aria');
    if (keyA) {
      var va = lookup(keyA, locale) || lookup(keyA, 'en');
      if (va != null) el.setAttribute('aria-label', va);
    }
  }

  function applyAll(locale) {
    document.documentElement.lang = locale;
    var nodes = document.querySelectorAll('[data-i18n], [data-i18n-placeholder], [data-i18n-title], [data-i18n-aria]');
    for (var i = 0; i < nodes.length; i++) applyToElement(nodes[i], locale);
    // Update toggle chip label
    var btn = document.getElementById('lymxLangChipBtn');
    if (btn) btn.firstChild && (btn.firstChild.nodeValue = '🌐 ');
    var lab = document.getElementById('lymxLangChipLabel');
    if (lab) lab.textContent = LABELS[locale] || locale;
  }

  // Watch for DOM additions (sidebar / nav inject after our first pass)
  var observer = null;
  function observeMutations(locale) {
    if (observer) observer.disconnect();
    observer = new MutationObserver(function (records) {
      var needsApply = false;
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType === 1) {
            if (n.hasAttribute && (n.hasAttribute('data-i18n') || n.hasAttribute('data-i18n-placeholder') || n.hasAttribute('data-i18n-title') || n.hasAttribute('data-i18n-aria'))) {
              applyToElement(n, locale);
            }
            if (n.querySelectorAll) {
              var children = n.querySelectorAll('[data-i18n], [data-i18n-placeholder], [data-i18n-title], [data-i18n-aria]');
              for (var k = 0; k < children.length; k++) applyToElement(children[k], locale);
            }
          }
        }
      }
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  // ---------- Language toggle chip --------------------------------------
  function injectChipStyles() {
    if (document.getElementById('lymxLangChipStyles')) return;
    var s = document.createElement('style');
    s.id = 'lymxLangChipStyles';
    s.textContent = ''
      /* 2026-05-20 #2b323e35 - right:120px overlapped Sign-out/My-account buttons on pages with full nav-cta (Help + Sign out + avatar). Bump to 220 so chip sits to the LEFT of the entire right-side cluster, not on top of it. Avatar dropdowns stay clear. */
      // 2026-05-20 #0caea9ca - the floating chip overlapped nav-cta buttons (Help/Sign-out) at 880-1100px viewports. We now try to dock the chip INTO the page's .nav-cta or .nav-links so it flows with the header. If no nav exists, fall back to fixed top-right at top:62px (below typical header heights) instead of top:14px.
      + '#lymxLangChip{position:fixed;top:62px;right:14px;z-index:99991;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}'
      + '#lymxLangChip.docked{position:static;display:inline-flex;align-items:center;top:auto;right:auto;margin-left:8px}'
      + '#lymxLangChipBtn{display:inline-flex;align-items:center;gap:6px;padding:7px 11px;background:rgba(255,255,255,.94);color:#0e1116;border:1px solid #e6e8ec;border-radius:999px;font-weight:700;font-size:13px;cursor:pointer;box-shadow:0 2px 8px rgba(14,17,22,.08);backdrop-filter:saturate(140%) blur(8px)}'
      + '#lymxLangChipBtn:hover{background:#fff;border-color:#cfd6e0}'
      + '#lymxLangMenu{position:fixed;top:96px;right:14px;z-index:99992;background:#fff;border:1px solid #e6e8ec;border-radius:10px;box-shadow:0 8px 24px rgba(14,17,22,.14);min-width:170px;padding:6px;display:none}'
      + '#lymxLangMenu.open{display:block}'
      + '#lymxLangMenu button{display:flex;width:100%;align-items:center;gap:10px;padding:8px 11px;background:transparent;border:0;border-radius:7px;cursor:pointer;font:600 13.5px/1.2 inherit;color:#1a1f27;text-align:left}'
      + '#lymxLangMenu button:hover{background:#eef4ff}'
      + '#lymxLangMenu button.active{background:#0e1116;color:#fff}'
      + '#lymxLangMenu .flag{width:22px;height:18px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;background:#f3f4f6;border-radius:4px;color:#374151}'
      + '#lymxLangMenu button.active .flag{background:rgba(255,255,255,.18);color:#fff}'
      /* On mobile the full nav-cta collapses to hamburger + avatar only, so 140px is enough to clear */
      + '@media (max-width:880px){#lymxLangChip:not(.docked){right:12px;top:62px}#lymxLangMenu{right:12px}}';
    document.head.appendChild(s);
  }

  function injectChip() {
    if (document.getElementById('lymxLangChip')) return;
    // Skip on login / pre-auth flows where it might collide with hero content
    // (still loads — just doesn't visually inject the chip there. Actually we DO want
    // it on every page so users can switch BEFORE signing in. Keep it on.)
    injectChipStyles();
    var wrap = document.createElement('div');
    wrap.id = 'lymxLangChip';
    var current = resolveLocale();
    wrap.innerHTML = '<button id="lymxLangChipBtn" type="button" aria-label="Language">🌐 <span id="lymxLangChipLabel">' + (LABELS[current] || 'EN') + '</span> ▾</button>';
    // 2026-05-20 #0caea9ca - try to dock the chip inside the page nav so it flows
    // with the header buttons. Falls back to fixed top-right if no nav anchor exists.
    var navCta = document.querySelector('.nav-cta');
    if (navCta) {
      wrap.classList.add('docked');
      navCta.insertBefore(wrap, navCta.firstChild);
    } else {
      document.body.appendChild(wrap);
    }

    var menu = document.createElement('div');
    menu.id = 'lymxLangMenu';
    menu.innerHTML = SUPPORTED.map(function (loc) {
      var active = (loc === current) ? ' active' : '';
      return '<button type="button" data-loc="' + loc + '" class="' + active.trim() + '"><span class="flag">' + (LABELS[loc] || loc) + '</span><span>' + (FULL_NAMES[loc] || loc) + '</span></button>';
    }).join('');
    document.body.appendChild(menu);

    document.getElementById('lymxLangChipBtn').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      menu.classList.toggle('open');
    });
    document.addEventListener('click', function (e) {
      if (e.target.closest && (e.target.closest('#lymxLangChip') || e.target.closest('#lymxLangMenu'))) return;
      menu.classList.remove('open');
    });
    menu.querySelectorAll('button[data-loc]').forEach(function (b) {
      b.addEventListener('click', function () {
        var loc = b.getAttribute('data-loc');
        setStoredLocale(loc);
        menu.classList.remove('open');
        // Update active state
        menu.querySelectorAll('button[data-loc]').forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-loc') === loc); });
        // Apply
        loadDict('en').then(function () {
          loadDict(loc).then(function () {
            applyAll(loc);
            observeMutations(loc);
            // Notify listeners
            window.dispatchEvent(new CustomEvent('lymx:locale-changed', { detail: { locale: loc } }));
          });
        });
      });
    });
  }

  // ---------- Public API ------------------------------------------------
  window.LymxI18n = {
    getLocale: resolveLocale,
    setLocale: function (loc) {
      if (SUPPORTED.indexOf(loc) === -1) return false;
      setStoredLocale(loc);
      loadDict('en').then(function () {
        loadDict(loc).then(function () {
          applyAll(loc);
          observeMutations(loc);
          var btnActive = document.querySelectorAll('#lymxLangMenu button[data-loc]');
          btnActive.forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-loc') === loc); });
          window.dispatchEvent(new CustomEvent('lymx:locale-changed', { detail: { locale: loc } }));
        });
      });
      return true;
    },
    t: function (key, fallback) {
      var loc = resolveLocale();
      return lookup(key, loc) || lookup(key, 'en') || fallback || key;
    },
    SUPPORTED: SUPPORTED,
    LABELS: LABELS,
    FULL_NAMES: FULL_NAMES
  };

  // ---------- Auto-translate add-on -------------------------------------
  // Loads /auto-translate-page.js once, which walks the DOM and translates
  // anything not owned by data-i18n into the active locale via Supabase EF
  // /functions/v1/translate-text (DeepL → Google → Haiku, server-cached).
  function loadAutoTranslate() {
    if (window.__LYMX_AUTOTRANSLATE_LOADED__) return;
    if (document.getElementById('lymxAutoTranslateScript')) return;
    var s = document.createElement('script');
    s.id = 'lymxAutoTranslateScript';
    s.src = 'auto-translate-page.js?v=1';
    s.defer = true;
    s.onerror = function () { console.warn('[i18n] auto-translate-page.js failed to load'); };
    document.head.appendChild(s);
  }

  // ---------- Init -----------------------------------------------------
  function start() {
    var locale = resolveLocale();
    // Always load English first as fallback, then target locale
    Promise.all([loadDict('en'), loadDict(locale)]).then(function () {
      applyAll(locale);
      observeMutations(locale);
      injectChip();
      loadAutoTranslate();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
