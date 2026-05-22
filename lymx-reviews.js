// lymx-reviews.js
// ---------------------------------------------------------------------------
// Drop-in review verification gate + Save Business button + recent reviews
// feed for any biz page on getlymx.com.
//
// USAGE — on any biz page, add 3 data attributes to <body>, then load this:
//   <body data-biz-slug="biz-brew-and-bean"
//         data-biz-name="Brew & Bean Café"
//         data-biz-emoji="☕">
//
//   <!-- review form skeleton (gate inserts itself before this element) -->
//   <form id="reviewForm" onsubmit="return false">
//     <div id="starPicker">...stars...</div>
//     <textarea id="reviewText" placeholder="What did you order?"></textarea>
//     <button type="submit">Post review & earn LYMX →</button>
//   </form>
//
//   <!-- a container for the recent reviews feed -->
//   <div class="reviews-list" data-reviews-feed></div>
//
//   <script src="lymx-config.js"></script>
//   <script src="lymx-auth.js" defer></script>
//   <script src="lymx-reviews.js" defer></script>
//
// Built 2026-05-16 — replaces the hardcoded block in biz-brew-and-bean.html.
// Pairs with migrations 030 / 031 / 032 / 033.
// ---------------------------------------------------------------------------

(function () {
  'use strict';

  function waitForReady(cb) {
    if (window.LYMX_CONFIG && window.LYMX && window.LYMX.getSession) return cb();
    setTimeout(function () { waitForReady(cb); }, 100);
  }

  function getBizConfig() {
    var b = document.body;
    return {
      slug:  b.dataset.bizSlug  || '',
      name:  b.dataset.bizName  || '',
      emoji: b.dataset.bizEmoji || ''
    };
  }

  async function init() {
    var BIZ = getBizConfig();
    if (!BIZ.slug || !BIZ.name) { console.warn('lymx-reviews: missing data-biz-slug / data-biz-name on <body>'); return; }
    var ANON = window.LYMX_CONFIG.SUPABASE_ANON_KEY;
    var URL  = window.LYMX_CONFIG.SUPABASE_URL;
    var session = await window.LYMX.getSession();
    var loginReturn = 'login.html?return=' + encodeURIComponent(location.pathname + location.search);

    wireStarPicker();
    wireReviewForm(BIZ, ANON, URL, session, loginReturn);
    loadRecentReviews(BIZ, ANON, URL);
    wireSaveBusinessButton(BIZ, ANON, URL, session, loginReturn);
  }

  // -------- Star picker --------
  function wireStarPicker() {
    var stars = document.querySelectorAll('#starPicker .star');
    var starLabel = document.getElementById('starLabel');
    if (!stars.length) return;
    window.__lymxRating = 0;
    stars.forEach(function (s, idx) {
      s.style.cursor = 'pointer';
      s.addEventListener('mouseenter', function () { paint(idx + 1); });
      s.addEventListener('click', function () {
        window.__lymxRating = idx + 1;
        paint(window.__lymxRating);
        if (starLabel) starLabel.textContent = window.__lymxRating + ' / 5 stars';
      });
    });
    var picker = document.getElementById('starPicker');
    if (picker) picker.addEventListener('mouseleave', function () { paint(window.__lymxRating); });
    function paint(n) { stars.forEach(function (s, i) { s.style.color = i < n ? '#d4a017' : '#d1d5db'; }); }
  }

  // -------- Verification gate + review submit --------
  function wireReviewForm(BIZ, ANON, URL, session, loginReturn) {
    var form = document.getElementById('reviewForm');
    if (!form) return;
    var state = { verifiedTxId: null, receiptImageUrl: null };

    // Build gate
    var gate = document.createElement('div');
    gate.id = 'lymxReviewGate';
    gate.style.cssText = 'background:#fff;border:1px solid #e6e8ec;border-radius:11px;padding:18px;margin-bottom:14px';
    gate.innerHTML = ''
      + '<div style="font-weight:700;font-size:15px;margin-bottom:4px;color:#0e1116">Verify your visit first</div>'
      + '<div style="font-size:13px;color:#5b6472;margin-bottom:14px">Every review on LYMX is receipt-verified. Pick one below — earns you 100 LYMX once verified.</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">'
      + '<button type="button" id="gateBtnTx" style="background:#0a84ff;color:#fff;border:none;padding:13px 14px;border-radius:9px;font-weight:700;font-size:13.5px;cursor:pointer;font-family:inherit">💳 Use a recent transaction</button>'
      + '<button type="button" id="gateBtnReceipt" style="background:#fff;color:#0a84ff;border:1.5px solid #0a84ff;padding:13px 14px;border-radius:9px;font-weight:700;font-size:13.5px;cursor:pointer;font-family:inherit">📸 Upload receipt photo</button>'
      + '</div>'
      + '<div id="gatePicker" style="margin-top:14px"></div>'
      + '<div id="gateStatus" style="display:none;margin-top:14px;padding:11px 13px;background:#e6f5ee;border:1px solid #a8d8c0;border-radius:9px;color:#0a6e44;font-size:13.5px;font-weight:600"></div>';
    form.parentNode.insertBefore(gate, form);
    form.style.display = 'none';

    var pickerArea = gate.querySelector('#gatePicker');
    var statusArea = gate.querySelector('#gateStatus');

    function showVerified(label) {
      statusArea.textContent = '✓ ' + label + ' — you can write your review below.';
      statusArea.style.display = 'block';
      pickerArea.innerHTML = '';
      form.style.display = '';
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Path A: transaction picker
    gate.querySelector('#gateBtnTx').addEventListener('click', async function () {
      if (!session) { location.href = loginReturn; return; }
      pickerArea.innerHTML = '<div style="color:#5b6472;font-size:13px">Loading your recent transactions…</div>';
      try {
        var r = await fetch(URL + '/rest/v1/rpc/my_recent_tx_at_business', {
          method: 'POST',
          headers: { apikey: ANON, Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_business_slug: BIZ.slug, p_business_name: BIZ.name })
        });
        var rows = r.ok ? await r.json() : [];
        if (!Array.isArray(rows) || !rows.length) {
          pickerArea.innerHTML = '<div style="background:#fff8e6;border:1px solid #f0d28a;color:#7a5a08;padding:12px 14px;border-radius:9px;font-size:13.5px">No recent transactions found at ' + esc(BIZ.name) + '. If you visited, please upload a photo of your receipt instead — admin verifies within 24 hours.</div>';
          return;
        }
        pickerArea.innerHTML = '<div style="font-size:13px;font-weight:700;color:#0e1116;margin-bottom:8px">Pick the visit you are reviewing:</div>'
          + rows.map(function (t) {
              var when = new Date(t.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
              var amt = (t.usd_basis ? '$' + Number(t.usd_basis).toFixed(2) : Number(t.lymx_amount).toFixed(0) + ' LYMX');
              return '<button type="button" data-txid="' + esc(t.transaction_id) + '" style="display:block;width:100%;text-align:left;background:#fff;border:1px solid #e6e8ec;padding:11px 13px;border-radius:9px;margin-bottom:7px;cursor:pointer;font-family:inherit"><div style="font-weight:700;color:#0e1116;font-size:14px">' + when + ' · ' + amt + '</div><div style="font-size:12px;color:#5b6472;margin-top:2px">' + esc(t.type) + '</div></button>';
            }).join('');
        pickerArea.querySelectorAll('button[data-txid]').forEach(function (b) {
          b.addEventListener('click', function () {
            state.verifiedTxId = b.dataset.txid;
            state.receiptImageUrl = null;
            showVerified('Visit verified by transaction');
          });
        });
      } catch (e) {
        pickerArea.innerHTML = '<div style="color:#b81324;font-size:13px">Could not load transactions: ' + esc(e.message) + '</div>';
      }
    });

    // Path B: receipt upload
    gate.querySelector('#gateBtnReceipt').addEventListener('click', function () {
      if (!session) { location.href = loginReturn; return; }
      pickerArea.innerHTML = '<label style="display:block;background:#f6f7f9;border:2px dashed #c9cdd4;border-radius:9px;padding:18px;text-align:center;cursor:pointer"><input type="file" id="gateReceiptFile" accept="image/*" capture="environment" style="display:none"><div style="font-size:14px;font-weight:700;color:#0e1116;margin-bottom:4px">📸 Tap to take a photo or upload</div><div style="font-size:12.5px;color:#5b6472">Receipt photo · admin verifies within 24 hours · then 100 LYMX is added to your wallet</div></label><div id="gateUploadStatus" style="margin-top:10px;font-size:13px;color:#5b6472"></div>';
      var fi = pickerArea.querySelector('#gateReceiptFile');
      var us = pickerArea.querySelector('#gateUploadStatus');
      fi.addEventListener('change', async function () {
        var file = fi.files && fi.files[0];
        if (!file) return;
        if (file.size > 6 * 1024 * 1024) { us.textContent = 'File is too large (>6 MB). Please pick a smaller photo.'; return; }
        us.textContent = 'Uploading…';
        // 2026-05-21 #243abe59 root-cause fix: receipt upload was returning HTTP 400.
        // Two issues stacked:
        // 1. encodeURIComponent on the full path turned the "/" folder separator into
        //    %2F. Supabase Storage's REST upload endpoint expects literal "/" between
        //    folder + filename, not %2F. Now: encode each segment independently and
        //    rejoin with "/".
        // 2. file.type can be empty on some mobile cameras / older browsers, which
        //    sets Content-Type to "" and triggers a 400 at the storage gateway. Now:
        //    fall back to image/jpeg when file.type is empty.
        // Plus: capture the response body on failure so future 400s aren't opaque.
        var ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
        var uid = session.user.id;
        var key = (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2))) + '.' + ext;
        var path = uid + '/' + key;
        var pathForUrl = encodeURIComponent(uid) + '/' + encodeURIComponent(key);
        var contentType = file.type || 'image/jpeg';
        try {
          var up = await fetch(URL + '/storage/v1/object/review-receipts/' + pathForUrl, {
            method: 'POST',
            headers: { apikey: ANON, Authorization: 'Bearer ' + session.access_token, 'Content-Type': contentType, 'x-upsert': 'false' },
            body: file
          });
          if (!up.ok) {
            var errBody = '';
            try { errBody = (await up.text()).slice(0, 160); } catch (_) {}
            throw new Error('upload HTTP ' + up.status + (errBody ? ' — ' + errBody : ''));
          }
          state.receiptImageUrl = path;
          state.verifiedTxId = null;
          showVerified('Receipt uploaded — pending admin verification');
        } catch (e) {
          us.textContent = 'Upload failed: ' + e.message;
        }
      });
    });

    // Submit
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (!session) { location.href = loginReturn; return; }
      if (!state.verifiedTxId && !state.receiptImageUrl) { alert('Please verify your visit first (transaction or receipt photo).'); return; }
      if ((window.__lymxRating || 0) < 1) { alert('Please pick a star rating first.'); return; }
      var bodyText = (document.getElementById('reviewText') || {}).value || '';
      if (bodyText.trim().length < 30) { alert('Reviews need at least 30 characters to earn LYMX.'); return; }
      var hasPhoto = false;
      document.querySelectorAll('.photo-slot input[type="file"]').forEach(function (inp) { if (inp.files && inp.files.length) hasPhoto = true; });
      var btn = form.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = 'Posting…'; }
      try {
        var payload = { reviewer_user_id: session.user.id, business_slug: BIZ.slug, business_name: BIZ.name, rating: window.__lymxRating, body: bodyText.trim(), has_photo: hasPhoto };
        if (state.verifiedTxId) payload.transaction_id = state.verifiedTxId;
        if (state.receiptImageUrl) payload.receipt_image_url = state.receiptImageUrl;
        var res = await fetch(URL + '/rest/v1/reviews', {
          method: 'POST',
          headers: { apikey: ANON, Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
          body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error('http ' + res.status + ': ' + (await res.text()));
        var instant = !!state.verifiedTxId;
        var heading = instant ? 'Review posted and verified!' : 'Review submitted!';
        var subhead = instant
          ? '+100 LYMX added to your wallet instantly. Thanks for keeping LYMX real.'
          : 'Receipt is being verified by admin (usually within 24 hours). Once approved, 100 LYMX will land in your wallet and your review will go live on this page.';
        gate.style.display = 'none';
        form.innerHTML = '<div style="padding:36px;text-align:center;font-size:16px;background:#e6f5ee;border-radius:11px;border:1px solid #a8d8c0"><div style="font-size:48px;color:#13a26b;margin-bottom:12px">✓</div><strong>' + heading + '</strong><div style="color:#0a6e44;margin-top:8px;font-size:14.5px">' + subhead + ' See it on <a href="my-reviews.html" style="color:#0050c7;font-weight:700">My Reviews</a>.</div></div>';
        loadRecentReviews(BIZ, ANON, URL);
      } catch (err) {
        if (btn) { btn.disabled = false; btn.textContent = 'Post review & earn LYMX →'; }
        alert('Could not save the review: ' + err.message);
      }
    });
  }

  // -------- Recent verified reviews feed --------
  async function loadRecentReviews(BIZ, ANON, URL) {
    var feed = document.querySelector('.reviews-list, #recentReviews, [data-reviews-feed]');
    if (!feed) return;
    try {
      var r = await fetch(URL + '/rest/v1/reviews?business_slug=eq.' + encodeURIComponent(BIZ.slug) + '&select=rating,body,has_photo,created_at&order=created_at.desc&limit=10', { headers: { apikey: ANON } });
      if (!r.ok) return;
      var rows = await r.json();
      if (!Array.isArray(rows) || !rows.length) {
        feed.innerHTML = '<div style="padding:24px;text-align:center;color:#5b6472;background:#f6f7f9;border-radius:9px">No verified reviews yet — be the first to verify a visit and earn 100 LYMX!</div>';
        return;
      }
      feed.innerHTML = rows.map(function (r) {
        var stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
        var when = new Date(r.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' });
        return '<div style="padding:14px 16px;background:#fff;border:1px solid #e6e8ec;border-radius:9px;margin-bottom:10px"><div style="color:#d4a017;font-size:14px;margin-bottom:6px">' + stars + (r.has_photo ? ' <span style="font-size:11px;color:#0a84ff;background:#EEF6FF;padding:2px 7px;border-radius:999px;margin-left:4px">photo</span>' : '') + '</div><div style="font-size:14px;color:#1a1f27">' + esc(r.body || '').replace(/\n/g, '<br>') + '</div><div style="font-size:11.5px;color:#5b6472;margin-top:6px">' + when + ' · Verified by receipt</div></div>';
      }).join('');
    } catch (e) { console.warn('[lymx-reviews.js:L229] silent error', e); }
  }

  // -------- Save Business floating chip --------
  function wireSaveBusinessButton(BIZ, ANON, URL, session, loginReturn) {
    var saveBtn = document.createElement('button');
    saveBtn.id = 'lymxSaveBtn';
    saveBtn.type = 'button';
    saveBtn.style.cssText = 'position:fixed;right:18px;bottom:74px;z-index:99997;background:#fff;color:#0e1116;border:1px solid #e6e8ec;padding:9px 16px;border-radius:999px;font-weight:700;font-size:13.5px;cursor:pointer;box-shadow:0 4px 12px rgba(14,17,22,.12);font-family:inherit;display:flex;align-items:center;gap:7px';
    saveBtn.innerHTML = '<span>☆</span><span>Save</span>';
    document.body.appendChild(saveBtn);

    async function refresh() {
      if (!session) { saveBtn.innerHTML = '<span>☆</span><span>Save</span>'; return; }
      try {
        var r = await fetch(URL + '/rest/v1/saved_businesses?user_id=eq.' + session.user.id + '&business_slug=eq.' + encodeURIComponent(BIZ.slug) + '&select=id', { headers: { apikey: ANON, Authorization: 'Bearer ' + session.access_token } });
        var rows = r.ok ? await r.json() : [];
        if (Array.isArray(rows) && rows.length) { saveBtn.innerHTML = '<span style="color:#d4a017">★</span><span>Saved</span>'; saveBtn.dataset.saved = '1'; }
        else { saveBtn.innerHTML = '<span>☆</span><span>Save</span>'; saveBtn.dataset.saved = ''; }
      } catch (e) { console.warn('[lymx-reviews.js:L248] silent error', e); }
    }
    refresh();
    saveBtn.addEventListener('click', async function () {
      if (!session) { location.href = loginReturn; return; }
      if (saveBtn.dataset.saved === '1') {
        await fetch(URL + '/rest/v1/saved_businesses?user_id=eq.' + session.user.id + '&business_slug=eq.' + encodeURIComponent(BIZ.slug), {
          method: 'DELETE', headers: { apikey: ANON, Authorization: 'Bearer ' + session.access_token }
        });
      } else {
        await fetch(URL + '/rest/v1/saved_businesses', {
          method: 'POST',
          headers: { apikey: ANON, Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: session.user.id, business_slug: BIZ.slug, business_name: BIZ.name, business_emoji: BIZ.emoji })
        });
      }
      await refresh();
    });
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) { return ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' })[c]; }); }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { waitForReady(init); });
  } else {
    waitForReady(init);
  }
})();
