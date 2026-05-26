// =============================================================================
// LYMX Power — Per-page Help widget (page-level playbook deep-link)
// =============================================================================
// Auto-injects a small floating "? Page guide" chip on the bottom-LEFT of any
// page that declares a playbook via `<body data-playbook-slug="...">`. Click
// the chip → a modal opens with that playbook rendered inline. Useful when a
// tester (or user) hits a page they're not sure how to navigate and needs the
// walkthrough WITHOUT leaving the page.
//
// The chip sits to the LEFT so it never collides with the feedback widget
// (bottom-right) or the floating Save button.
//
// How to tag a page:
//   <body data-playbook-slug="business-onboarding-01-invite">
//
// The slug must match an entry in playbooks/INDEX.md (`[<slug>](path.md)`).
// Loading is lazy — the .md file is only fetched the first time the chip is
// clicked. Resulting HTML is rendered with marked.js if available, otherwise
// shown as preformatted text. The modal supports keyboard close (Escape) and
// click-outside.
//
// Built 2026-05-26 alongside the universal playbooks.html.
// =============================================================================
(function () {
  if (window.__LYMX_PB_HELP_LOADED__) return;
  window.__LYMX_PB_HELP_LOADED__ = true;

  var BASE_PATH = 'playbooks/';

  // The slug→file mapping is fetched once from playbooks/INDEX.md on first
  // open, then cached on window. Keeps the per-page widget zero-config; the
  // page only declares its slug, this script resolves to the .md path.
  var slugToFile = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }

  function injectStyles() {
    if (document.getElementById('lymx-pb-help-styles')) return;
    var s = document.createElement('style');
    s.id = 'lymx-pb-help-styles';
    s.textContent = ''
      + '.lymx-pb-chip{position:fixed;left:18px;bottom:18px;z-index:9997;'
      + '  background:#fff;color:#0a84ff;border:1px solid #cfe0ff;'
      + '  padding:9px 14px;border-radius:999px;font-weight:700;font-size:13px;'
      + '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;'
      + '  box-shadow:0 4px 14px rgba(10,132,255,.22);cursor:pointer;'
      + '  display:flex;align-items:center;gap:7px;transition:background .12s,border-color .12s}'
      + '.lymx-pb-chip:hover{background:#eef6ff;border-color:#0a84ff}'
      + '.lymx-pb-chip:active{transform:translateY(1px)}'
      + '.lymx-pb-modal{position:fixed;inset:0;background:rgba(14,17,22,.55);'
      + '  z-index:9998;display:none;align-items:center;justify-content:center;padding:18px}'
      + '.lymx-pb-modal.open{display:flex}'
      + '.lymx-pb-card{background:#fff;border-radius:14px;max-width:880px;width:100%;'
      + '  max-height:calc(100vh - 36px);display:flex;flex-direction:column;overflow:hidden;'
      + '  box-shadow:0 24px 80px rgba(0,0,0,.4);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;color:#0e1116}'
      + '.lymx-pb-head{display:flex;justify-content:space-between;align-items:center;'
      + '  padding:14px 20px;border-bottom:1px solid #e6e8ec;flex-shrink:0}'
      + '.lymx-pb-head .ttl{font-weight:800;font-size:15px;display:flex;align-items:center;gap:8px}'
      + '.lymx-pb-head .tools{display:flex;gap:8px;align-items:center}'
      + '.lymx-pb-head a.full{font-size:12.5px;color:#0a84ff;text-decoration:none;font-weight:700}'
      + '.lymx-pb-head a.full:hover{text-decoration:underline}'
      + '.lymx-pb-head button{background:transparent;border:0;font-size:22px;cursor:pointer;color:#5b6472;padding:0 6px;line-height:1}'
      + '.lymx-pb-body{padding:18px 26px 26px;overflow-y:auto;font-size:14.5px;line-height:1.55;flex:1}'
      + '.lymx-pb-body h1{margin:0 0 6px;font-size:22px;font-weight:800;letter-spacing:-.01em}'
      + '.lymx-pb-body h2{margin:18px 0 6px;font-size:17px;font-weight:800}'
      + '.lymx-pb-body h3{margin:14px 0 4px;font-size:14.5px;font-weight:800;color:#1a1f27}'
      + '.lymx-pb-body p{margin:6px 0}'
      + '.lymx-pb-body ul,.lymx-pb-body ol{margin:6px 0 10px;padding-left:22px}'
      + '.lymx-pb-body li{margin:3px 0}'
      + '.lymx-pb-body code{background:#f6f7f9;padding:1px 5px;border-radius:5px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}'
      + '.lymx-pb-body pre{background:#0e1116;color:#e6e8ec;padding:12px 14px;border-radius:8px;overflow-x:auto;font-size:12.5px;line-height:1.45}'
      + '.lymx-pb-body blockquote{margin:8px 0;padding:8px 12px;background:#fffaeb;border-left:4px solid #f0a020;color:#5a3e00;border-radius:0 7px 7px 0;font-size:13.5px}'
      + '.lymx-pb-body table{border-collapse:collapse;margin:8px 0;font-size:13px;width:100%}'
      + '.lymx-pb-body th,.lymx-pb-body td{border:1px solid #e6e8ec;padding:6px 9px;text-align:left;vertical-align:top}'
      + '.lymx-pb-body th{background:#f6f7f9;font-weight:700}'
      + '.lymx-pb-body hr{border:0;border-top:1px solid #e6e8ec;margin:16px 0}'
      + '.lymx-pb-body a{color:#0a84ff;text-decoration:underline}'
      + '.lymx-pb-meta{background:#f6f7f9;border-radius:8px;padding:9px 12px;font-size:12px;color:#5b6472;margin-bottom:14px;display:flex;gap:14px;flex-wrap:wrap}'
      + '.lymx-pb-meta b{color:#0e1116;font-weight:700}'
      + '@media(max-width:600px){.lymx-pb-chip{left:14px;bottom:14px;padding:7px 11px;font-size:12.5px}}';
    document.head.appendChild(s);
  }

  function buildChip(slug) {
    var b = document.createElement('button');
    b.className = 'lymx-pb-chip';
    b.id = 'lymxPbHelpChip';
    b.type = 'button';
    b.setAttribute('aria-label', 'Open the playbook for this page');
    b.innerHTML = '<span>📖</span><span>Page guide</span>';
    return b;
  }

  function buildModal() {
    var m = document.createElement('div');
    m.className = 'lymx-pb-modal';
    m.id = 'lymxPbHelpModal';
    m.innerHTML = ''
      + '<div class="lymx-pb-card" role="dialog" aria-modal="true">'
      +   '<div class="lymx-pb-head">'
      +     '<div class="ttl"><span>📖</span><span id="lymxPbHeadTitle">Page guide</span></div>'
      +     '<div class="tools">'
      +       '<a id="lymxPbFullLink" class="full" href="#" target="_blank" rel="noopener">Open full page →</a>'
      +       '<button type="button" aria-label="Close" id="lymxPbHelpClose">×</button>'
      +     '</div>'
      +   '</div>'
      +   '<div class="lymx-pb-body" id="lymxPbHelpBody">Loading…</div>'
      + '</div>';
    return m;
  }

  function parseFrontmatter(md) {
    var fm = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!fm) return { meta: {}, body: md };
    var meta = {};
    fm[1].split(/\r?\n/).forEach(function (ln) {
      var kv = ln.match(/^([a-zA-Z_]+):\s*(.*?)$/);
      if (kv) meta[kv[1]] = kv[2].trim();
    });
    return { meta: meta, body: fm[2] };
  }

  // Strict slug-only INDEX scan (mirrors playbooks.html's parser)
  async function loadIndex() {
    if (slugToFile) return slugToFile;
    slugToFile = {};
    try {
      var r = await fetch(BASE_PATH + 'INDEX.md?_t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('INDEX.md http ' + r.status);
      var md = await r.text();
      md.split(/\r?\n/).forEach(function (ln) {
        var row = ln.match(/^\|\s*\[([a-z0-9-]+)\]\(([^)]+)\)\s*\|/i);
        if (row) slugToFile[row[1].trim()] = row[2].trim();
      });
    } catch (e) {
      console.warn('[lymx-playbook-help] loadIndex', e);
    }
    return slugToFile;
  }

  async function ensureMarked() {
    if (window.marked) return;
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js';
      s.onload = function () { resolve(); };
      s.onerror = function () { resolve(); }; // fall through; we'll render as <pre>
      document.head.appendChild(s);
    });
  }

  async function open(slug) {
    var modal = document.getElementById('lymxPbHelpModal');
    var body = document.getElementById('lymxPbHelpBody');
    var fullLink = document.getElementById('lymxPbFullLink');
    var headTitle = document.getElementById('lymxPbHeadTitle');
    if (!modal) return;
    modal.classList.add('open');
    body.textContent = 'Loading…';
    headTitle.textContent = 'Page guide';
    fullLink.href = 'playbooks.html?p=' + encodeURIComponent(slug);

    var map = await loadIndex();
    var file = map[slug];
    if (!file) {
      body.innerHTML = '<div style="padding:24px 0;color:#5b6472;text-align:center">'
        + 'No playbook found for this page (<code>' + escapeHtml(slug) + '</code>). '
        + 'If you got here from a tester email, the playbook may not have been published yet. '
        + 'Try the <a href="playbooks.html" style="color:#0a84ff">full Playbooks page</a> instead.'
        + '</div>';
      return;
    }
    try {
      var r = await fetch(BASE_PATH + file + '?_t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      var md = await r.text();
      var parsed = parseFrontmatter(md);
      await ensureMarked();
      var metaHtml = '';
      var meta = parsed.meta;
      if (meta.title || meta.role || meta.duration_min) {
        if (meta.title) headTitle.textContent = meta.title;
        metaHtml = '<div class="lymx-pb-meta">'
                 + (meta.role ? '<span><b>Role:</b> ' + escapeHtml(meta.role) + '</span>' : '')
                 + (meta.duration_min ? '<span><b>Time:</b> ~' + escapeHtml(meta.duration_min) + ' min</span>' : '')
                 + (meta.difficulty ? '<span><b>Difficulty:</b> ' + escapeHtml(meta.difficulty) + '</span>' : '')
                 + (meta.last_verified ? '<span><b>Last verified:</b> ' + escapeHtml(meta.last_verified) + '</span>' : '')
                 + '</div>';
      }
      var bodyHtml = window.marked ? window.marked.parse(parsed.body) : ('<pre>' + escapeHtml(parsed.body) + '</pre>');
      body.innerHTML = metaHtml + bodyHtml;
      body.scrollTop = 0;
    } catch (e) {
      body.innerHTML = '<div style="padding:18px;color:#b81324">Couldn\'t load this playbook (' + escapeHtml(e.message || String(e)) + '). Try refreshing.</div>';
      console.warn('[lymx-playbook-help] load', e);
    }
  }

  function close() {
    var modal = document.getElementById('lymxPbHelpModal');
    if (modal) modal.classList.remove('open');
  }

  function boot() {
    var slug = (document.body.dataset.playbookSlug || '').trim();
    if (!slug) return; // page didn't tag itself; widget stays dormant
    injectStyles();
    var chip = buildChip(slug);
    var modal = buildModal();
    document.body.appendChild(chip);
    document.body.appendChild(modal);

    chip.addEventListener('click', function () { open(slug); });
    document.getElementById('lymxPbHelpClose').addEventListener('click', close);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
