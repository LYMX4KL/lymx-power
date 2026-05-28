// =============================================================================
// LYMX Power — Auto-translate every page (the engine that doesn't need data-i18n)
// =============================================================================
// Mirror of the InvestPro PM auto-translate-page.js (2026-05-18).
//
// WHAT IT DOES
//   Walks the rendered DOM of any page that loaded `lymx-i18n.js`, collects
//   every visible text node not already owned by the dictionary layer
//   (data-i18n="..." / data-no-translate / <code> / <pre> / <kbd> / <samp>),
//   and translates them via /functions/v1/translate-text. Cache hits return
//   instantly; cache misses go through DeepL → Google → Haiku (server-side).
//
// WHEN IT RUNS
//   lymx-i18n.js calls loadAutoTranslate() once on page boot after injectChip().
//   If the active locale is English, this script does nothing (originals are
//   already English). On any non-English locale, it walks + translates.
//   Re-runs on every `lymx:locale-changed` event (chip click).
//
// HOW ENGLISH RESTORE WORKS
//   Every text node we touch is keyed in a WeakMap with its original English
//   value. When the user flips back to English, we walk the map and restore
//   each node — no network call, instantaneous.
//
// OPT-OUT
//   <span data-no-translate>InvestPro Realty</span>
//   <pre data-no-translate>SQL…</pre>
//   plus the implicit skips above. data-i18n="..." also wins (dictionary path).
//
// COST
//   ~$0.0001 per unique phrase first time. Cached forever after. A dashboard
//   with 80 strings × 5 non-English locales × $0.0001 = 4¢ to fully prime,
//   then $0/visit forever.
// =============================================================================

(function () {
  if (window.__LYMX_AUTOTRANSLATE_LOADED__) return;
  window.__LYMX_AUTOTRANSLATE_LOADED__ = true;

  // ---- Config -----------------------------------------------------------
  var SUPABASE_URL = (window.LYMX_CONFIG && window.LYMX_CONFIG.SUPABASE_URL) || "";
  var SUPABASE_ANON = (window.LYMX_CONFIG && window.LYMX_CONFIG.SUPABASE_ANON_KEY) || "";
  var TRANSLATE_URL = SUPABASE_URL + "/functions/v1/translate-text";
  var MAX_CONCURRENT = 6;
  var MIN_TEXT_LEN = 2;
  var MAX_TEXT_LEN = 1000;

  // ---- State ------------------------------------------------------------
  var originalMap = new WeakMap();   // textNode → original English string
  var inflight = new Map();          // (locale|text) → Promise<translated>
  var phraseCache = new Map();       // (locale|text) → translated (process-local)
  var activeRun = 0;                 // counter to cancel stale runs

  // ---- Helpers ----------------------------------------------------------
  function getLocale() {
    try {
      if (window.LymxI18n && window.LymxI18n.getLocale) return window.LymxI18n.getLocale();
    } catch (e) { console.warn('[auto-translate-page.js:L57] silent error', e); }
    try { return localStorage.getItem("lymx_locale") || "en"; } catch (_) { return "en"; }
  }

  function getBearerToken() {
    // 1) Logged-in Supabase session
    try {
      if (window.lymxSupabase && window.lymxSupabase.auth) {
        var s = window.lymxSupabase.auth._session || null;
        if (s && s.access_token) return s.access_token;
      }
    } catch (_) { console.warn('[auto-translate-page] best-effort', _); }
    // 2) Scrape sb-*-auth-token from localStorage (Supabase v2 convention)
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && /^sb-.*-auth-token$/.test(k)) {
          var raw = localStorage.getItem(k);
          var obj = raw ? JSON.parse(raw) : null;
          var tok = obj && (obj.access_token || (obj.currentSession && obj.currentSession.access_token));
          if (tok) return tok;
        }
      }
    } catch (_) { console.warn('[auto-translate-page] best-effort', _); }
    // 3) Public pages: fall back to anon key
    return SUPABASE_ANON;
  }

  function shouldSkip(node) {
    var p = node.parentElement;
    while (p) {
      var tag = p.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "CODE" || tag === "PRE" || tag === "KBD" || tag === "SAMP" || tag === "TEMPLATE" || tag === "TEXTAREA") return true;
      if (p.hasAttribute && (p.hasAttribute("data-i18n") || p.hasAttribute("data-no-translate"))) return true;
      // hidden elements (display:none) — still translate; user might toggle to visible
      p = p.parentElement;
    }
    return false;
  }

  function collectTextNodes(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var text = n.nodeValue;
        if (!text) return NodeFilter.FILTER_REJECT;
        var trimmed = text.trim();
        if (trimmed.length < MIN_TEXT_LEN || trimmed.length > MAX_TEXT_LEN) return NodeFilter.FILTER_REJECT;
        // Skip nodes that are just punctuation/digits/whitespace
        if (!/[A-Za-zÀ-ɏ]/.test(trimmed)) return NodeFilter.FILTER_REJECT;
        if (shouldSkip(n)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var out = [];
    var n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function snapshotOriginal(node) {
    if (!originalMap.has(node)) originalMap.set(node, node.nodeValue);
    return originalMap.get(node);
  }

  function restoreOriginals(nodes) {
    nodes.forEach(function (n) {
      var orig = originalMap.get(n);
      if (orig != null && n.nodeValue !== orig) n.nodeValue = orig;
    });
  }

  async function translateOne(text, locale) {
    var key = locale + "|" + text;
    if (phraseCache.has(key)) return phraseCache.get(key);
    if (inflight.has(key)) return inflight.get(key);
    var token = getBearerToken();
    var p = fetch(TRANSLATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON,
        "Authorization": "Bearer " + token,
      },
      body: JSON.stringify({ text: text, target_locale: locale, source_locale: "en" }),
    }).then(function (r) { return r.json(); }).then(function (j) {
      var out = (j && j.ok && j.translated_text) ? j.translated_text : text;
      phraseCache.set(key, out);
      inflight.delete(key);
      return out;
    }).catch(function (_e) {
      inflight.delete(key);
      return text;
    });
    inflight.set(key, p);
    return p;
  }

  // Run with bounded concurrency
  async function runQueue(items, concurrency, onItem) {
    var i = 0;
    var active = 0;
    return new Promise(function (resolve) {
      function next() {
        if (i >= items.length && active === 0) return resolve();
        while (active < concurrency && i < items.length) {
          var idx = i++;
          active++;
          Promise.resolve(onItem(items[idx], idx)).finally(function () {
            active--;
            next();
          });
        }
      }
      next();
    });
  }

  // ---- Main entry: translate the whole document into `locale` ----------
  async function translatePage(locale) {
    var thisRun = ++activeRun;
    var nodes = collectTextNodes(document.body);
    if (!nodes.length) return;

    if (locale === "en") {
      restoreOriginals(nodes);
      return;
    }

    // Capture originals + group by unique text so we batch dedupe
    var byText = new Map(); // text → array of nodes
    nodes.forEach(function (n) {
      var orig = snapshotOriginal(n);
      var stripped = orig.replace(/\s+/g, " ").trim();
      if (!stripped) return;
      if (!byText.has(stripped)) byText.set(stripped, []);
      byText.get(stripped).push({ node: n, original: orig });
    });

    var phrases = Array.from(byText.keys());
    await runQueue(phrases, MAX_CONCURRENT, async function (phrase) {
      if (thisRun !== activeRun) return; // a newer run started, bail
      var translated = await translateOne(phrase, locale);
      if (thisRun !== activeRun) return;
      var targets = byText.get(phrase) || [];
      targets.forEach(function (t) {
        // Preserve original leading/trailing whitespace in the node
        var leading = (t.original.match(/^\s*/) || [""])[0];
        var trailing = (t.original.match(/\s*$/) || [""])[0];
        try { t.node.nodeValue = leading + translated + trailing; } catch (e) { console.warn('[auto-translate-page.js:L205] silent error', e); }
      });
    });
  }

  // ---- Wire up: initial run + re-run on locale change ------------------
  function onReady() {
    if (!SUPABASE_URL) {
      console.warn("[auto-translate] LYMX_CONFIG.SUPABASE_URL missing — cannot translate");
      return;
    }
    translatePage(getLocale());
    window.addEventListener("lymx:locale-changed", function (e) {
      var loc = (e && e.detail && e.detail.locale) || getLocale();
      translatePage(loc);
    });
    // Also re-walk when new content is injected (modals, dynamic lists)
    var debounceTimer = null;
    var observer = new MutationObserver(function () {
      if (getLocale() === "en") return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () { translatePage(getLocale()); }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: false });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onReady);
  } else {
    onReady();
  }

  // ---- Public API for diagnostics ---------------------------------------
  window.LymxAutoTranslate = {
    run: function (locale) { return translatePage(locale || getLocale()); },
    restore: function () { restoreOriginals(collectTextNodes(document.body)); },
    cacheSize: function () { return phraseCache.size; },
  };
})();
