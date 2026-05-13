// LYMX feedback button — drop-in. Adds a floating "Send Feedback" button
// bottom-right of every page that loads this script.
//
// Depends on:
//   - window.LYMX_CONFIG (from lymx-config.js) for SUPABASE_URL + ANON_KEY
//   - window.LYMX (from lymx-auth.js) optional — used to attribute submissions
//     to the signed-in user. Anonymous submissions also work.
//
// Just include this script before </body>:
//   <script src="lymx-config.js"></script>
//   <script src="lymx-feedback.js" defer></script>

(function () {
  if (window.__LYMX_FEEDBACK_LOADED__) return;
  window.__LYMX_FEEDBACK_LOADED__ = true;

  if (!window.LYMX_CONFIG || !window.LYMX_CONFIG.SUPABASE_URL) {
    // Page hasn't loaded lymx-config.js — abort silently. Don't bother the user
    // when the integration isn't set up; the button just won't appear.
    console.warn('[LYMX feedback] LYMX_CONFIG not loaded; feedback button disabled');
    return;
  }

  // ---------- CSS ----------
  var css = ''
    + '#lymx-fb-btn{position:fixed;right:18px;bottom:18px;z-index:99998;background:#0e1116;color:#fff;border:0;padding:11px 18px;border-radius:999px;font-weight:700;font-size:13.5px;cursor:pointer;box-shadow:0 8px 24px rgba(14,17,22,.25);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;display:flex;align-items:center;gap:7px;transition:.15s}'
    + '#lymx-fb-btn:hover{background:#1a1f27;transform:translateY(-1px);box-shadow:0 10px 28px rgba(14,17,22,.32)}'
    + '#lymx-fb-overlay{position:fixed;inset:0;background:rgba(14,17,22,.55);z-index:99999;display:none;align-items:center;justify-content:center;padding:18px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;animation:lymxfbfade .15s ease-out}'
    + '@keyframes lymxfbfade{from{opacity:0}to{opacity:1}}'
    + '#lymx-fb-overlay.on{display:flex}'
    + '#lymx-fb-modal{background:#fff;border-radius:14px;width:100%;max-width:520px;max-height:92vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3);animation:lymxfbpop .2s ease-out}'
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
    + '#lymx-fb-modal .auto{font-size:12px;color:#5b6472;margin:10px 0 0;padding:9px 11px;background:#f6f7f9;border-radius:8px;line-height:1.5}'
    + '#lymx-fb-modal .actions{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}'
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
    + '@media(max-width:520px){#lymx-fb-btn{right:12px;bottom:12px;font-size:12.5px;padding:9px 14px}#lymx-fb-modal .row{grid-template-columns:1fr}}';
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ---------- Markup ----------
  var btn = document.createElement('button');
  btn.id = 'lymx-fb-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Send feedback');
  btn.innerHTML = '<span aria-hidden="true">💬</span> Send Feedback';

  var overlay = document.createElement('div');
  overlay.id = 'lymx-fb-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'lymx-fb-h');
  overlay.innerHTML =
      '<div id="lymx-fb-modal">'
    + '  <div class="hd">'
    + '    <div>'
    + '      <h2 id="lymx-fb-h">Send Feedback</h2>'
    + '      <p class="sub">We read every one. Bug, suggestion, or just a question — anything helps.</p>'
    + '    </div>'
    + '    <button class="x" type="button" aria-label="Close" data-fb-close>×</button>'
    + '  </div>'
    + '  <div class="body">'
    + '    <div class="row">'
    + '      <div>'
    + '        <label for="lymx-fb-type">Type</label>'
    + '        <select id="lymx-fb-type">'
    + '          <option value="bug">🐛 Bug — something is broken</option>'
    + '          <option value="question">🆘 Help — I need a hand</option>'
    + '          <option value="suggestion">💡 Idea — make this better</option>'
    + '          <option value="general" selected>📋 Other — anything else</option>'
    + '        </select>'
    + '      </div>'
    + '      <div>'
    + '        <label for="lymx-fb-priority">Priority</label>'
    + '        <select id="lymx-fb-priority">'
    + '          <option value="urgent">🔴 Urgent</option>'
    + '          <option value="high">🟡 High</option>'
    + '          <option value="normal" selected>🔵 Normal</option>'
    + '          <option value="low">⚪ Low</option>'
    + '        </select>'
    + '      </div>'
    + '    </div>'
    + '    <label for="lymx-fb-subject">Subject (optional, auto-filled if blank)</label>'
    + '    <input id="lymx-fb-subject" type="text" placeholder="Short headline" maxlength="80" />'
    + '    <label for="lymx-fb-message">Your message</label>'
    + '    <textarea id="lymx-fb-message" placeholder="What did you see? What would you change?" minlength="10"></textarea>'
    + '    <div class="auto">We\'ll automatically include the page URL, your role, and the current time so we can reproduce the issue.</div>'
    + '    <div class="actions" style="justify-content:space-between">'
    + '      <a href="/my-feedback.html" style="font-size:12.5px;color:#5b6472;text-decoration:underline;align-self:center">📋 View my submissions</a>'
    + '      <div style="display:flex;gap:10px">'
    + '        <button type="button" class="btn btn-cancel" data-fb-close>Cancel</button>'
    + '        <button type="button" class="btn btn-send" id="lymx-fb-send">Send Feedback</button>'
    + '      </div>'
    + '    </div>'
    + '    <div class="notice" id="lymx-fb-notice"></div>'
    + '  </div>'
    + '</div>';

  function attach() {
    if (!document.body) return setTimeout(attach, 50);
    document.body.appendChild(btn);
    document.body.appendChild(overlay);

    // Open
    btn.addEventListener('click', open);
    // Close handlers
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
    overlay.querySelectorAll('[data-fb-close]').forEach(function (el) {
      el.addEventListener('click', close);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.classList.contains('on')) close();
    });

    // Submit
    document.getElementById('lymx-fb-send').addEventListener('click', submit);
  }

  function open() {
    overlay.classList.add('on');
    document.body.style.overflow = 'hidden';
    setTimeout(function () {
      var msg = document.getElementById('lymx-fb-message');
      if (msg) msg.focus();
    }, 50);
    notice(null);
  }
  function close() {
    overlay.classList.remove('on');
    document.body.style.overflow = '';
  }
  function notice(text, kind) {
    var n = document.getElementById('lymx-fb-notice');
    if (!text) { n.className = 'notice'; n.textContent = ''; return; }
    n.className = 'notice show ' + (kind || 'err');
    n.textContent = text;
  }

  async function submit() {
    var type = document.getElementById('lymx-fb-type').value;
    var priority = document.getElementById('lymx-fb-priority').value;
    var subject = document.getElementById('lymx-fb-subject').value.trim();
    var message = document.getElementById('lymx-fb-message').value.trim();
    var sendBtn = document.getElementById('lymx-fb-send');

    if (message.length < 10) {
      notice('Please write at least 10 characters describing what you want to share.', 'err');
      return;
    }

    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    notice(null);

    var payload = {
      type: type,
      priority: priority,
      subject: subject || undefined,
      message: message,
      page_url: window.location.href,
      viewport: window.innerWidth + 'x' + window.innerHeight,
      user_agent: navigator.userAgent,
    };

    // Try to use the user's session JWT if signed in (so we attribute correctly)
    var token = window.LYMX_CONFIG.SUPABASE_ANON_KEY;
    try {
      if (window.LYMX && window.LYMX.getSession) {
        var session = await window.LYMX.getSession();
        if (session && session.access_token) token = session.access_token;
      }
    } catch (e) { /* fall back to anon */ }

    try {
      var res = await fetch(
        window.LYMX_CONFIG.SUPABASE_URL + '/functions/v1/feedback-submit',
        {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'apikey': window.LYMX_CONFIG.SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        }
      );
      var data = null;
      try { data = await res.json(); } catch {}
      if (!res.ok) {
        notice((data && data.error) || ('Submit failed: ' + res.status), 'err');
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Feedback';
        return;
      }
      notice('Thanks! Sent. We\'ll dig in shortly.', 'ok');
      sendBtn.textContent = 'Sent ✓';
      // Clear form for next time
      document.getElementById('lymx-fb-subject').value = '';
      document.getElementById('lymx-fb-message').value = '';
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
