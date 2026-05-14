// LYMX feedback widget — v2 (2026-05-14)
// Floating "Send Feedback" button + modal with:
//   • Page-context badge (auto-shows what page you're reporting from)
//   • Auto-screenshot of the page on open (html2canvas, lazy-loaded)
//   • Region selector (drag to crop a piece of the page)
//   • Upload-image button
//   • AI Improve button (rewrites rough notes into a clean report)
//   • AI Live Tips (debounced suggestions as you type)
//   • Draft autosave to localStorage so reload doesn't lose typing
//
// Depends on:
//   - window.LYMX_CONFIG (from lymx-config.js) for SUPABASE_URL + ANON_KEY
//   - window.LYMX (from lymx-auth.js) optional — used to attribute submissions
//
// Just include this script before </body>:
//   <script src="lymx-config.js"></script>
//   <script src="lymx-feedback.js" defer></script>

(function () {
  if (window.__LYMX_FEEDBACK_LOADED__) return;
  window.__LYMX_FEEDBACK_LOADED__ = true;

  if (!window.LYMX_CONFIG || !window.LYMX_CONFIG.SUPABASE_URL) {
    console.warn('[LYMX feedback] LYMX_CONFIG not loaded; feedback button disabled');
    return;
  }

  var FB_DRAFT_KEY = 'lymx_feedback_draft_v2';

  // ---------- CSS ----------
  var css = ''
    + '#lymx-fb-btn{position:fixed;right:18px;bottom:18px;z-index:99998;background:#0e1116;color:#fff;border:0;padding:11px 18px;border-radius:999px;font-weight:700;font-size:13.5px;cursor:pointer;box-shadow:0 8px 24px rgba(14,17,22,.25);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;display:flex;align-items:center;gap:7px;transition:.15s}'
    + '#lymx-fb-btn:hover{background:#1a1f27;transform:translateY(-1px);box-shadow:0 10px 28px rgba(14,17,22,.32)}'
    + '#lymx-fb-overlay{position:fixed;inset:0;background:rgba(14,17,22,.55);z-index:99999;display:none;align-items:center;justify-content:center;padding:18px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;animation:lymxfbfade .15s ease-out}'
    + '@keyframes lymxfbfade{from{opacity:0}to{opacity:1}}'
    + '#lymx-fb-overlay.on{display:flex}'
    + '#lymx-fb-modal{background:#fff;border-radius:14px;width:100%;max-width:560px;max-height:92vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3);animation:lymxfbpop .2s ease-out}'
    + '@keyframes lymxfbpop{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}'
    + '#lymx-fb-modal .hd{display:flex;justify-content:space-between;align-items:flex-start;padding:22px 22px 8px}'
    + '#lymx-fb-modal h2{margin:0 0 4px;font-size:19px;font-weight:800;color:#0e1116}'
    + '#lymx-fb-modal .sub{margin:0;color:#5b6472;font-size:13.5px}'
    + '#lymx-fb-modal .x{background:transparent;border:0;font-size:24px;color:#5b6472;cursor:pointer;padding:0 6px;line-height:1}'
    + '#lymx-fb-modal .x:hover{color:#0e1116}'
    + '#lymx-fb-modal .body{padding:8px 22px 22px}'
    + '#lymx-fb-modal label{display:block;font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#5b6472;margin:14px 0 6px}'
    + '#lymx-fb-modal select,#lymx-fb-modal input,#lymx-fb-modal textarea{width:100%;padding:10px 12px;border:1px solid #e6e8ec;border-radius:9px;font-size:14.5px;font-family:inherit;color:#0e1116;background:#fff;outline:none;transition:.15s;box-sizing:border-box}'
    + '#lymx-fb-modal select:focus,#lymx-fb-modal input:focus,#lymx-fb-modal textarea:focus{border-color:#0a84ff;box-shadow:0 0 0 3px rgba(10,132,255,.12)}'
    + '#lymx-fb-modal textarea{min-height:110px;resize:vertical;line-height:1.5}'
    + '#lymx-fb-modal .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}'
    + '#lymx-fb-modal .page-badge{background:#EEF2FF;border:1px solid #C7D2FE;border-radius:8px;padding:10px 12px;margin-top:8px;font-size:12.5px;color:#3730A3;display:flex;align-items:center;gap:8px}'
    + '#lymx-fb-modal .page-badge .pb-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:#1E40AF;word-break:break-all;line-height:1.35}'
    + '#lymx-fb-modal .msg-row{display:flex;align-items:center;justify-content:space-between;margin:14px 0 6px}'
    + '#lymx-fb-modal .msg-row label{margin:0}'
    + '#lymx-fb-modal .ai-btn{background:linear-gradient(135deg,#7C3AED,#6366F1);color:#fff;border:0;border-radius:999px;padding:6px 12px;font-size:11.5px;font-weight:700;cursor:pointer;letter-spacing:.03em;box-shadow:0 1px 4px rgba(99,102,241,.35)}'
    + '#lymx-fb-modal .ai-btn:hover{filter:brightness(1.1)}'
    + '#lymx-fb-modal .ai-btn:disabled{opacity:.6;cursor:not-allowed}'
    + '#lymx-fb-modal .ai-tips{margin-top:8px;padding:9px 12px;background:#F5F3FF;border-left:3px solid #7C3AED;border-radius:0 8px 8px 0;font-size:12.5px;color:#5B21B6;line-height:1.5;display:none}'
    + '#lymx-fb-modal .ai-tips.show{display:block}'
    + '#lymx-fb-modal .ai-tips ul{margin:4px 0 0 18px;padding:0}'
    + '#lymx-fb-modal .shot-box{margin-top:14px;border:1px solid #e6e8ec;border-radius:9px;padding:12px;background:#f9fafb}'
    + '#lymx-fb-modal .shot-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px;flex-wrap:wrap}'
    + '#lymx-fb-modal .shot-row label{margin:0;color:#0e1116;text-transform:none;letter-spacing:0;font-size:13px;font-weight:700}'
    + '#lymx-fb-modal .shot-btns{display:flex;gap:6px;flex-wrap:wrap}'
    + '#lymx-fb-modal .shot-btn{background:#fff;color:#0a84ff;border:1px solid #0a84ff;border-radius:6px;padding:5px 10px;font-size:11.5px;font-weight:600;cursor:pointer}'
    + '#lymx-fb-modal .shot-btn:hover{background:#EEF6FF}'
    + '#lymx-fb-modal .shot-preview{text-align:center;padding:10px;background:#fff;border:1px dashed #C7D2FE;border-radius:6px;min-height:80px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#5b6472;font-size:12.5px;gap:6px}'
    + '#lymx-fb-modal .shot-preview img{max-width:100%;max-height:160px;border-radius:5px;border:1px solid #C7D2FE}'
    + '#lymx-fb-modal .shot-meta{display:flex;align-items:center;gap:8px;font-size:11.5px;color:#5b6472}'
    + '#lymx-fb-modal .shot-clear{background:none;border:0;color:#B91C1C;cursor:pointer;font-size:11.5px;text-decoration:underline;padding:0}'
    + '#lymx-fb-modal .actions{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:18px}'
    + '#lymx-fb-modal .actions-right{display:flex;gap:8px}'
    + '#lymx-fb-modal .btn{padding:10px 18px;border-radius:9px;font-weight:600;font-size:13.5px;border:0;cursor:pointer;font-family:inherit}'
    + '#lymx-fb-modal .btn-cancel{background:#fff;border:1px solid #e6e8ec;color:#5b6472}'
    + '#lymx-fb-modal .btn-cancel:hover{border-color:#0e1116;color:#0e1116}'
    + '#lymx-fb-modal .btn-send{background:#0e1116;color:#fff}'
    + '#lymx-fb-modal .btn-send:hover{background:#000}'
    + '#lymx-fb-modal .btn-send:disabled{opacity:.5;cursor:not-allowed}'
    + '#lymx-fb-modal .notice{padding:11px 13px;border-radius:9px;font-size:13px;margin-top:12px;display:none}'
    + '#lymx-fb-modal .notice.show{display:block}'
    + '#lymx-fb-modal .notice.ok{background:#e6f5ee;border:1px solid #a8d8c0;color:#0a6e44}'
    + '#lymx-fb-modal .notice.err{background:#fdecec;border:1px solid #f5b7b7;color:#9b1c1c}'
    + '#lymx-fb-modal .my-link{font-size:12px;color:#5b6472;text-decoration:underline}'
    + '@media(max-width:520px){#lymx-fb-btn{right:12px;bottom:12px;font-size:12.5px;padding:9px 14px}#lymx-fb-modal .row{grid-template-columns:1fr}}';
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  function shortPath() {
    try {
      var p = location.pathname || '/';
      return p.length > 60 ? '…' + p.slice(-58) : p;
    } catch (e) { return '/'; }
  }

  var btn = document.createElement('button');
  btn.id = 'lymx-fb-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Send feedback');
  btn.innerHTML = '<span aria-hidden="true">💬</span> Send Feedback';

  var overlay = document.createElement('div');
  overlay.id = 'lymx-fb-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML =
      '<div id="lymx-fb-modal">'
    + '<div class="hd"><div><h2>Send Feedback</h2><p class="sub">We read every one.</p></div>'
    + '<button class="x" type="button" aria-label="Close" data-fb-close>×</button></div>'
    + '<div class="body">'
    + '<div class="page-badge"><span>📍</span><div style="flex:1"><div style="font-weight:700;font-size:11.5px;letter-spacing:.04em;text-transform:uppercase">Reporting from</div><div class="pb-path">' + shortPath() + '</div></div></div>'
    + '<div class="row" style="margin-top:8px">'
    +   '<div><label for="lymx-fb-type">Type</label>'
    +   '<select id="lymx-fb-type"><option value="bug">🐛 Bug — something is broken</option><option value="question">🆘 Help — I need a hand</option><option value="suggestion">💡 Idea — make this better</option><option value="general" selected>📋 Other — anything else</option></select></div>'
    +   '<div><label for="lymx-fb-priority">Priority</label>'
    +   '<select id="lymx-fb-priority"><option value="urgent">🔴 Urgent</option><option value="high">🟡 High</option><option value="normal" selected>🔵 Normal</option><option value="low">⚪ Low</option></select></div>'
    + '</div>'
    + '<label for="lymx-fb-subject">Subject (optional, auto-filled if blank)</label>'
    + '<input id="lymx-fb-subject" type="text" placeholder="Short headline" maxlength="80" />'
    + '<div class="msg-row"><label for="lymx-fb-message" style="margin:0">Your message</label>'
    + '<button type="button" class="ai-btn" id="lymx-fb-ai-polish" title="Let AI rewrite your notes into a clear report">✨ Improve with AI</button></div>'
    + '<textarea id="lymx-fb-message" placeholder="What did you see? What would you change?" minlength="10"></textarea>'
    + '<div class="ai-tips" id="lymx-fb-ai-tips"></div>'
    + '<div class="shot-box"><div class="shot-row"><label>📸 Screenshot</label>'
    +   '<div class="shot-btns">'
    +   '<button type="button" class="shot-btn" id="lymx-fb-shot-auto">↻ Recapture</button>'
    +   '<button type="button" class="shot-btn" id="lymx-fb-shot-region">🎯 Select region</button>'
    +   '<button type="button" class="shot-btn" id="lymx-fb-shot-upload">📎 Upload</button></div></div>'
    + '<input type="file" id="lymx-fb-shot-file" accept="image/*" style="display:none" />'
    + '<div class="shot-preview" id="lymx-fb-shot-preview"><span id="lymx-fb-shot-status">Capturing page…</span></div></div>'
    + '<div class="actions"><a href="/my-feedback.html" class="my-link">📋 View my submissions</a>'
    + '<div class="actions-right">'
    + '<button type="button" class="btn btn-cancel" data-fb-close>Cancel</button>'
    + '<button type="button" class="btn btn-send" id="lymx-fb-send">Send Feedback</button></div></div>'
    + '<div class="notice" id="lymx-fb-notice"></div>'
    + '</div></div>';

  // ---------- State ----------
  var shotBlob = null;
  var shotKind = 'none';
  var aiTipsTimer = null;
  var lastTipsFor = '';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
  }

  function loadH2C() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    if (window.__h2cPromise) return window.__h2cPromise;
    window.__h2cPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
      s.onload = function () { resolve(window.html2canvas); };
      s.onerror = function () { reject(new Error('html2canvas failed to load')); };
      document.head.appendChild(s);
    });
    return window.__h2cPromise;
  }

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(blob);
    });
  }

  function renderShotPreview(label) {
    var preview = document.getElementById('lymx-fb-shot-preview');
    if (!preview) return;
    if (!shotBlob) {
      preview.innerHTML = '<span style="color:#5b6472;font-size:12.5px">No screenshot attached.</span>';
      return;
    }
    var url = URL.createObjectURL(shotBlob);
    var sizeKB = Math.round(shotBlob.size / 1024);
    preview.innerHTML =
        '<img src="' + url + '" alt="screenshot preview" />'
      + '<div class="shot-meta"><span>📸 ' + esc(label) + '</span><span>·</span><span>' + sizeKB + ' KB</span>'
      + '<button type="button" class="shot-clear" id="lymx-fb-shot-clear">remove</button></div>';
    var clr = document.getElementById('lymx-fb-shot-clear');
    if (clr) clr.addEventListener('click', function () {
      shotBlob = null; shotKind = 'none';
      renderShotPreview('removed');
    });
  }

  function captureAuto() {
    var status = document.getElementById('lymx-fb-shot-status');
    if (status) status.textContent = 'Capturing page…';
    return loadH2C().then(function (html2canvas) {
      overlay.style.visibility = 'hidden';
      return new Promise(function (r) { setTimeout(r, 80); }).then(function () {
        return html2canvas(document.body, {
          useCORS: true, logging: false,
          scale: Math.min(1, window.devicePixelRatio || 1),
          windowWidth: document.documentElement.clientWidth,
          windowHeight: document.documentElement.clientHeight
        });
      });
    }).then(function (canvas) {
      overlay.style.visibility = 'visible';
      return new Promise(function (res) { canvas.toBlob(res, 'image/png', 0.9); });
    }).then(function (blob) {
      shotBlob = blob; shotKind = 'auto';
      renderShotPreview('Auto-captured');
    }).catch(function (e) {
      overlay.style.visibility = 'visible';
      console.warn('[LYMX feedback] auto-capture failed', e);
      var preview = document.getElementById('lymx-fb-shot-preview');
      if (preview) preview.innerHTML = '<span style="color:#B91C1C;font-size:12.5px">Auto-capture failed — try 🎯 Select region or 📎 Upload.</span>';
    });
  }

  function captureRegion() {
    var baseCanvas = null;
    loadH2C().then(function (html2canvas) {
      overlay.style.visibility = 'hidden';
      return new Promise(function (r) { setTimeout(r, 80); }).then(function () {
        return html2canvas(document.body, {
          useCORS: true, logging: false,
          scale: Math.min(1, window.devicePixelRatio || 1),
          windowWidth: document.documentElement.clientWidth,
          windowHeight: document.documentElement.clientHeight
        });
      });
    }).then(function (canvas) {
      baseCanvas = canvas;
      overlay.style.visibility = 'visible';
      var picker = document.createElement('div');
      picker.style.cssText = 'position:fixed;inset:0;z-index:100000;cursor:crosshair;background:rgba(14,17,22,.4)';
      var hint = document.createElement('div');
      hint.textContent = 'Drag to select a region — Esc to cancel';
      hint.style.cssText = 'position:absolute;top:14px;left:50%;transform:translateX(-50%);background:#0e1116;color:#fff;padding:8px 16px;border-radius:999px;font:600 13px sans-serif;pointer-events:none';
      var sel = document.createElement('div');
      sel.style.cssText = 'position:absolute;border:2px dashed #FBBF24;background:rgba(251,191,36,.18);display:none';
      picker.appendChild(hint); picker.appendChild(sel);
      overlay.style.display = 'none';
      document.body.appendChild(picker);
      var startX = 0, startY = 0, dragging = false;
      function done(canceled, rect) {
        picker.remove();
        overlay.style.display = 'flex';
        document.removeEventListener('keydown', onEsc);
        if (canceled || !rect || rect.w < 6 || rect.h < 6) return;
        var dpr = baseCanvas.width / document.documentElement.clientWidth;
        var sx = Math.max(0, Math.floor(rect.x * dpr));
        var sy = Math.max(0, Math.floor(rect.y * dpr));
        var sw = Math.floor(rect.w * dpr);
        var sh = Math.floor(rect.h * dpr);
        var out = document.createElement('canvas');
        out.width = sw; out.height = sh;
        out.getContext('2d').drawImage(baseCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
        out.toBlob(function (b) {
          shotBlob = b; shotKind = 'region';
          renderShotPreview('Selected region');
        }, 'image/png', 0.92);
      }
      function onEsc(e) { if (e.key === 'Escape') done(true); }
      document.addEventListener('keydown', onEsc);
      picker.addEventListener('mousedown', function (e) {
        dragging = true; startX = e.clientX; startY = e.clientY;
        sel.style.display = 'block'; sel.style.left = startX + 'px'; sel.style.top = startY + 'px';
        sel.style.width = '0px'; sel.style.height = '0px';
      });
      picker.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        var x = Math.min(startX, e.clientX), y = Math.min(startY, e.clientY);
        var w = Math.abs(e.clientX - startX), h = Math.abs(e.clientY - startY);
        sel.style.left = x+'px'; sel.style.top = y+'px';
        sel.style.width = w+'px'; sel.style.height = h+'px';
      });
      picker.addEventListener('mouseup', function (e) {
        if (!dragging) return;
        dragging = false;
        var x = Math.min(startX, e.clientX), y = Math.min(startY, e.clientY);
        var w = Math.abs(e.clientX - startX), h = Math.abs(e.clientY - startY);
        done(false, { x: x, y: y, w: w, h: h });
      });
    }).catch(function (e) {
      overlay.style.visibility = 'visible';
      console.warn('[LYMX feedback] region capture failed', e);
    });
  }

  // ---------- AI (optional, degrades silently) ----------
  async function aiCall(mode, payload) {
    try {
      var token = window.LYMX_CONFIG.SUPABASE_ANON_KEY;
      if (window.LYMX && window.LYMX.getSession) {
        try {
          var s = await window.LYMX.getSession();
          if (s && s.access_token) token = s.access_token;
        } catch (e) {}
      }
      var res = await fetch(
        window.LYMX_CONFIG.SUPABASE_URL + '/functions/v1/feedback-ai-assist',
        {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'apikey': window.LYMX_CONFIG.SUPABASE_ANON_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(Object.assign({ mode: mode }, payload))
        }
      );
      if (!res.ok) return null;
      var j = await res.json();
      return j && j.ok ? j.data : null;
    } catch (e) {
      console.warn('[LYMX feedback] AI assist unavailable', e);
      return null;
    }
  }

  function scheduleTips() {
    clearTimeout(aiTipsTimer);
    var msgEl = document.getElementById('lymx-fb-message');
    var tipsEl = document.getElementById('lymx-fb-ai-tips');
    if (!msgEl || !tipsEl) return;
    var text = msgEl.value.trim();
    if (text.length < 20) { tipsEl.className = 'ai-tips'; return; }
    if (text === lastTipsFor) return;
    aiTipsTimer = setTimeout(async function () {
      lastTipsFor = text;
      var data = await aiCall('suggest', {
        message: text, page_url: location.href, page_title: document.title,
        category: document.getElementById('lymx-fb-type').value
      });
      if (!data || !Array.isArray(data.tips) || !data.tips.length) {
        tipsEl.className = 'ai-tips'; return;
      }
      var html = '<strong>💡 To help us fix it faster, try adding:</strong><ul>';
      for (var i = 0; i < Math.min(3, data.tips.length); i++) html += '<li>' + esc(data.tips[i]) + '</li>';
      html += '</ul>';
      tipsEl.innerHTML = html;
      tipsEl.className = 'ai-tips show';
    }, 1400);
  }

  async function doPolish() {
    var msgEl = document.getElementById('lymx-fb-message');
    var tipsEl = document.getElementById('lymx-fb-ai-tips');
    var polishBtn = document.getElementById('lymx-fb-ai-polish');
    var text = (msgEl && msgEl.value || '').trim();
    if (!text) {
      msgEl && msgEl.focus();
      if (tipsEl) {
        tipsEl.innerHTML = '<span style="color:#B91C1C">Type a few notes first, then I\'ll clean them up.</span>';
        tipsEl.className = 'ai-tips show';
      }
      return;
    }
    var orig = polishBtn ? polishBtn.textContent : '';
    if (polishBtn) { polishBtn.disabled = true; polishBtn.textContent = '✨ Polishing…'; }
    var data = await aiCall('polish', {
      message: text, page_url: location.href, page_title: document.title,
      category: document.getElementById('lymx-fb-type').value
    });
    if (polishBtn) { polishBtn.disabled = false; polishBtn.textContent = orig || '✨ Improve with AI'; }
    if (data && data.polished) {
      msgEl.dataset.originalMessage = text;
      msgEl.value = data.polished;
      if (data.summary) msgEl.dataset.aiSummary = data.summary;
      saveDraft();
      if (tipsEl) {
        tipsEl.innerHTML = '<span>✨ Polished by AI. Your original is preserved for our records.</span>';
        tipsEl.className = 'ai-tips show';
      }
    } else if (tipsEl) {
      tipsEl.innerHTML = '<span style="color:#B91C1C">Couldn\'t reach the AI helper — please send as-is.</span>';
      tipsEl.className = 'ai-tips show';
    }
  }

  function saveDraft() {
    try {
      var draft = {
        type: (document.getElementById('lymx-fb-type') || {}).value,
        priority: (document.getElementById('lymx-fb-priority') || {}).value,
        subject: (document.getElementById('lymx-fb-subject') || {}).value,
        message: (document.getElementById('lymx-fb-message') || {}).value,
        ts: Date.now()
      };
      if (!draft.message || !draft.message.trim()) localStorage.removeItem(FB_DRAFT_KEY);
      else localStorage.setItem(FB_DRAFT_KEY, JSON.stringify(draft));
    } catch (e) {}
  }
  function loadDraft() {
    try {
      var raw = localStorage.getItem(FB_DRAFT_KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (d.ts && Date.now() - d.ts > 14 * 24 * 60 * 60 * 1000) {
        localStorage.removeItem(FB_DRAFT_KEY); return;
      }
      if (d.type) document.getElementById('lymx-fb-type').value = d.type;
      if (d.priority) document.getElementById('lymx-fb-priority').value = d.priority;
      if (d.subject) document.getElementById('lymx-fb-subject').value = d.subject;
      if (d.message) {
        document.getElementById('lymx-fb-message').value = d.message;
        notice('↻ Draft restored from before you navigated away.', 'ok');
      }
    } catch (e) {}
  }
  function clearDraft() { try { localStorage.removeItem(FB_DRAFT_KEY); } catch (e) {} }

  function attach() {
    if (!document.body) return setTimeout(attach, 50);
    document.body.appendChild(btn);
    document.body.appendChild(overlay);

    btn.addEventListener('click', open);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.querySelectorAll('[data-fb-close]').forEach(function (el) { el.addEventListener('click', close); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.classList.contains('on')) close();
    });

    document.getElementById('lymx-fb-shot-auto').addEventListener('click', captureAuto);
    document.getElementById('lymx-fb-shot-region').addEventListener('click', captureRegion);
    document.getElementById('lymx-fb-shot-upload').addEventListener('click', function () {
      document.getElementById('lymx-fb-shot-file').click();
    });
    document.getElementById('lymx-fb-shot-file').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      if (f.type.indexOf('image/') !== 0) {
        var p = document.getElementById('lymx-fb-shot-preview');
        if (p) p.innerHTML = '<span style="color:#B91C1C;font-size:12.5px">Please pick an image file.</span>';
        return;
      }
      if (f.size > 5 * 1024 * 1024) {
        var p2 = document.getElementById('lymx-fb-shot-preview');
        if (p2) p2.innerHTML = '<span style="color:#B91C1C;font-size:12.5px">Image too large (max 5 MB).</span>';
        return;
      }
      shotBlob = f; shotKind = 'upload';
      renderShotPreview('Uploaded ' + f.name);
    });

    document.getElementById('lymx-fb-ai-polish').addEventListener('click', doPolish);
    var msgEl = document.getElementById('lymx-fb-message');
    msgEl.addEventListener('input', function () { scheduleTips(); saveDraft(); });

    ['lymx-fb-type','lymx-fb-priority','lymx-fb-subject'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) {
        el.addEventListener('change', saveDraft);
        el.addEventListener('input', saveDraft);
      }
    });

    document.getElementById('lymx-fb-send').addEventListener('click', submit);
  }

  function open() {
    overlay.classList.add('on');
    document.body.style.overflow = 'hidden';
    try {
      var pb = overlay.querySelector('.pb-path');
      if (pb) pb.textContent = shortPath();
    } catch (e) {}
    notice(null);
    loadDraft();
    setTimeout(captureAuto, 250);
    setTimeout(function () {
      var msg = document.getElementById('lymx-fb-message');
      if (msg && !msg.value) msg.focus();
    }, 60);
  }
  function close() {
    overlay.classList.remove('on');
    document.body.style.overflow = '';
  }
  function notice(text, kind) {
    var n = document.getElementById('lymx-fb-notice');
    if (!n) return;
    if (!text) { n.className = 'notice'; n.textContent = ''; return; }
    n.className = 'notice show ' + (kind || 'err');
    n.textContent = text;
  }

  async function submit() {
    var type = document.getElementById('lymx-fb-type').value;
    var priority = document.getElementById('lymx-fb-priority').value;
    var subject = document.getElementById('lymx-fb-subject').value.trim();
    var msgEl = document.getElementById('lymx-fb-message');
    var message = msgEl.value.trim();
    var originalMessage = msgEl.dataset.originalMessage || null;
    var aiSummary = msgEl.dataset.aiSummary || null;
    var sendBtn = document.getElementById('lymx-fb-send');

    if (message.length < 10) {
      notice('Please write at least 10 characters describing what you want to share.', 'err');
      return;
    }
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    notice(null);

    var screenshot_b64 = null;
    if (shotBlob) {
      try { screenshot_b64 = await blobToDataURL(shotBlob); }
      catch (e) { console.warn('[LYMX feedback] couldn\'t convert screenshot', e); }
    }

    var payload = {
      type: type, priority: priority,
      subject: subject || undefined,
      message: message,
      original_message: originalMessage,
      ai_summary: aiSummary,
      page_url: window.location.href,
      page_title: document.title,
      viewport: window.innerWidth + 'x' + window.innerHeight,
      user_agent: navigator.userAgent,
      screenshot_b64: screenshot_b64,
      screenshot_kind: shotBlob ? shotKind : null
    };

    var token = window.LYMX_CONFIG.SUPABASE_ANON_KEY;
    try {
      if (window.LYMX && window.LYMX.getSession) {
        var session = await window.LYMX.getSession();
        if (session && session.access_token) token = session.access_token;
      }
    } catch (e) {}

    try {
      var res = await fetch(
        window.LYMX_CONFIG.SUPABASE_URL + '/functions/v1/feedback-submit',
        {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'apikey': window.LYMX_CONFIG.SUPABASE_ANON_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        }
      );
      var data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) {
        notice((data && data.error) || ('Submit failed: ' + res.status), 'err');
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Feedback';
        return;
      }
      notice('Thanks! Sent. We\'ll dig in shortly.', 'ok');
      sendBtn.textContent = 'Sent ✓';
      clearDraft();
      msgEl.value = ''; msgEl.dataset.originalMessage = ''; msgEl.dataset.aiSummary = '';
      document.getElementById('lymx-fb-subject').value = '';
      shotBlob = null; shotKind = 'none';
      setTimeout(function () {
        close();
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Feedback';
      }, 1400);
    } catch (err) {
      notice('Network error: ' + (err.message || err), 'err');
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send Feedback';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }
})();
