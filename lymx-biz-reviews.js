// LYMX biz-page reviews module — replaces the hardcoded summary, review list,
// and mock-alert write form on biz-<slug>.html pages with real DB-driven
// behavior wired to public.reviews.
//
// Created 2026-05-28 (Kenny: "build the feature per the no-band-aid rule,
// we are in testing now, remove all the hardcoded shit").
//
// What it does, per page that includes it:
//   1. Page sets window.LYMX_BIZ_PAGE = { slug: 'biz-oakline-kitchen',
//      name: 'Oakline Kitchen' }
//   2. Calls window.LYMX_BizReviews.boot()  (or this script auto-boots on
//      DOMContentLoaded if LYMX_BIZ_PAGE is set).
//   3. Loads reviews from public.reviews by business_slug, renders avg
//      rating, count, 5-bar histogram, and the most-recent review cards.
//   4. Wires the "Write a review" form to validate (rating >= 1, body >= 30
//      chars) and INSERT into public.reviews; reloads the list on success.
//
// Page HTML contract (already in biz-oakline-kitchen.html after the
// hardcoded blocks are stripped):
//   <div class="big" id="reviewsAvg"></div>
//   <div class="stars-big-2" id="reviewsAvgStars"></div>
//   <div class="big-sub" id="reviewsCount"></div>
//   <div class="breakdown" id="reviewsHistogram"></div>
//   <div class="review-list" id="reviewsList"></div>
//   <form id="writeReviewForm">
//     <div class="star-picker" id="starPicker">
//       <span class="star" data-v="1">...</span> ... (5 stars)
//     </div>
//     <span id="starLabel"></span>
//     <textarea id="reviewText"></textarea>
//     <button type="submit">...</button>
//   </form>
//
// Page lookup uses window.LYMX_CONFIG (SUPABASE_URL + ANON key) and the
// authed user's token from localStorage to attribute the review.

(function () {
  if (window.LYMX_BizReviews) return;

  function $(id) { return document.getElementById(id); }

  function decodeToken(t) {
    try { var p = t.split('.'); return JSON.parse(atob(p[1].replace(/-/g, '+').replace(/_/g, '/'))); }
    catch (e) { return null; }
  }

  function getAuth() {
    if (!window.LYMX_CONFIG) return null;
    try {
      var m = window.LYMX_CONFIG.SUPABASE_URL.match(/https:\/\/([^.]+)\.supabase\.co/i);
      var ref = m ? m[1] : null;
      if (!ref) return null;
      var raw = localStorage.getItem('sb-' + ref + '-auth-token');
      if (!raw) return null;
      var o = JSON.parse(raw);
      var at = (o && o.access_token) || (o && o.currentSession && o.currentSession.access_token);
      var p = at ? decodeToken(at) : null;
      return at ? { token: at, user_id: p && p.sub, email: p && p.email } : null;
    } catch (e) {
      console.warn('[lymx-biz-reviews] getAuth', e);
      return null;
    }
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
    });
  }

  function initials(seed) {
    var s = String(seed || 'xx').replace(/-/g, '');
    return (s.slice(0, 1) + s.slice(s.length - 1)).toUpperCase();
  }

  function relTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var diffMs = now - d;
    var mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
    var days = Math.floor(hrs / 24);
    if (days < 2) return 'yesterday';
    if (days < 7) return days + ' days ago';
    if (days < 14) return '1 week ago';
    if (days < 30) return Math.floor(days / 7) + ' weeks ago';
    if (days < 60) return '1 month ago';
    if (days < 365) return Math.floor(days / 30) + ' months ago';
    return Math.floor(days / 365) + ' years ago';
  }

  function starsText(n) {
    n = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
    return '★'.repeat(n) + '☆'.repeat(5 - n);
  }

  function renderSummary(rows) {
    var avgEl = $('reviewsAvg'), starsEl = $('reviewsAvgStars'),
        ctEl = $('reviewsCount'), histEl = $('reviewsHistogram');

    if (!rows.length) {
      if (avgEl) avgEl.textContent = '—';
      if (starsEl) starsEl.textContent = '☆☆☆☆☆';
      if (ctEl) ctEl.textContent = 'No reviews yet';
      if (histEl) histEl.innerHTML =
        '<div style="padding:14px 0;font-size:13px;color:var(--muted);text-align:center">' +
        'Be the first to share your visit — write a review below.</div>';
      return;
    }

    var sum = 0, n = 0;
    var buckets = [0, 0, 0, 0, 0, 0]; // index 1..5
    rows.forEach(function (r) {
      if (r.rating >= 1 && r.rating <= 5) {
        sum += r.rating; n++;
        buckets[r.rating]++;
      }
    });
    var avg = n ? (sum / n) : 0;
    if (avgEl) avgEl.textContent = n ? avg.toFixed(1) : '—';
    if (starsEl) starsEl.textContent = starsText(avg);
    if (ctEl) ctEl.textContent = rows.length + (rows.length === 1 ? ' review' : ' reviews');

    if (histEl) {
      var html = '';
      for (var i = 5; i >= 1; i--) {
        var ct = buckets[i];
        var pct = rows.length ? Math.round(ct * 100 / rows.length) : 0;
        html +=
          '<div class="bar">' +
            '<span>' + i + '★</span>' +
            '<div class="track"><div class="fill" style="width:' + pct + '%"></div></div>' +
            '<span style="text-align:right">' + ct + '</span>' +
          '</div>';
      }
      histEl.innerHTML = html;
    }
  }

  function renderList(rows) {
    var list = $('reviewsList');
    if (!list) return;
    if (!rows.length) {
      list.innerHTML =
        '<div style="padding:24px;text-align:center;color:var(--muted);background:#fff;border:1px solid var(--line);border-radius:14px">' +
        'No reviews yet — be the first to share your visit using the form below.' +
        '</div>';
      return;
    }
    list.innerHTML = rows.slice(0, 20).map(function (r) {
      var verified = r.verification_status === 'verified';
      var av = initials(r.reviewer_user_id);
      return (
        '<div class="review-card">' +
          '<div class="head">' +
            '<div class="author">' +
              '<div class="avatar">' + av + '</div>' +
              '<div>' +
                '<div class="name">LYMX member</div>' +
                '<div class="when">' + escHtml(relTime(r.created_at)) + '</div>' +
              '</div>' +
            '</div>' +
            (verified
              ? '<span class="badge-verified">✓ Verified visit</span>'
              : '<span class="badge-verified" style="background:rgba(91,100,114,.12);color:#5b6472">Pending verification</span>') +
          '</div>' +
          '<div class="stars-row">' + starsText(r.rating) + '</div>' +
          '<p class="quote">' + escHtml(r.body) + '</p>' +
        '</div>'
      );
    }).join('');
  }

  async function loadReviews(slug) {
    if (!window.LYMX_CONFIG || !slug) return;
    var cfg = window.LYMX_CONFIG;
    try {
      // Pull pending + verified; pending count toward total but get a lighter
      // visual treatment in the list. Rejected reviews never display.
      var url = cfg.SUPABASE_URL + '/rest/v1/reviews?business_slug=eq.' +
        encodeURIComponent(slug) +
        '&verification_status=in.(verified,pending)' +
        '&select=id,rating,body,created_at,reviewer_user_id,verification_status' +
        '&order=created_at.desc&limit=200';
      var r = await fetch(url, { headers: { apikey: cfg.SUPABASE_ANON_KEY } });
      if (!r.ok) {
        console.warn('[lymx-biz-reviews] load failed', r.status);
        renderSummary([]); renderList([]);
        return;
      }
      var rows = await r.json();
      renderSummary(rows); renderList(rows);
    } catch (e) {
      console.warn('[lymx-biz-reviews] load error', e);
      renderSummary([]); renderList([]);
    }
  }

  function wireStarPicker() {
    var picker = $('starPicker'); var label = $('starLabel');
    if (!picker) return;
    var labels = ['Tap to rate', '1 — Poor', '2 — Fair', '3 — Good', '4 — Great', '5 — Excellent'];
    picker.dataset.value = '0';
    picker.querySelectorAll('.star').forEach(function (s) {
      s.style.cursor = 'pointer';
      s.addEventListener('click', function () {
        var v = parseInt(s.dataset.v, 10) || 0;
        picker.dataset.value = String(v);
        picker.querySelectorAll('.star').forEach(function (s2) {
          var sv = parseInt(s2.dataset.v, 10) || 0;
          s2.classList.toggle('on', sv <= v);
          s2.style.color = sv <= v ? '#f0a020' : '';
        });
        if (label) label.textContent = labels[v];
      });
    });
  }

  function wireForm(slug, name) {
    var form = $('writeReviewForm');
    if (!form) return;
    // Strip any inline mock-alert handler that may still be present.
    form.removeAttribute('onsubmit');
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var picker = $('starPicker');
      var rating = picker ? parseInt(picker.dataset.value || '0', 10) : 0;
      var body = ($('reviewText') ? $('reviewText').value : '').trim();
      var btn = form.querySelector('button[type="submit"]');

      // Validation — addresses #95c3b6ad (empty submissions used to go
      // through the mock alert).
      if (rating < 1 || rating > 5) {
        alert('Please tap a star rating (1–5) before posting your review.');
        return;
      }
      if (body.length < 30) {
        alert('Please write at least 30 characters describing your visit so other LYMX members can use it. (' +
              body.length + ' so far.)');
        return;
      }

      var auth = getAuth();
      if (!auth || !auth.token || !auth.user_id) {
        if (confirm('You need to be signed in to post a review. Sign in now?')) {
          var ret = encodeURIComponent(location.pathname + location.search);
          location.href = '/login.html?return=' + ret;
        }
        return;
      }

      if (btn) { btn.disabled = true; btn.dataset._t = btn.textContent; btn.textContent = 'Posting…'; }

      try {
        var r = await fetch(window.LYMX_CONFIG.SUPABASE_URL + '/rest/v1/reviews', {
          method: 'POST',
          headers: {
            apikey: window.LYMX_CONFIG.SUPABASE_ANON_KEY,
            Authorization: 'Bearer ' + auth.token,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({
            business_slug: slug,
            business_name: name,
            reviewer_user_id: auth.user_id,
            rating: rating,
            body: body
          })
        });
        if (!r.ok) {
          var txt = await r.text();
          var msg = txt;
          try { var j = JSON.parse(txt); msg = j.message || j.error || txt; }
          catch (parseErr) { console.warn('[lymx-biz-reviews] error body was not JSON', parseErr); }
          alert('Could not post the review: ' + msg);
          if (btn) { btn.disabled = false; btn.textContent = btn.dataset._t || 'Post review'; }
          return;
        }
        // Success: reset, reload
        form.reset();
        if (picker) {
          picker.dataset.value = '0';
          picker.querySelectorAll('.star').forEach(function (s) {
            s.classList.remove('on'); s.style.color = '';
          });
        }
        var label = $('starLabel'); if (label) label.textContent = 'Tap to rate';
        if (btn) { btn.disabled = false; btn.textContent = btn.dataset._t || 'Post review'; }
        alert('Thanks — your review is posted. It will appear publicly once verified (usually within 24 hours).');
        loadReviews(slug);
      } catch (e) {
        console.warn('[lymx-biz-reviews] submit failed', e);
        alert('Network error — please try again in a moment.');
        if (btn) { btn.disabled = false; btn.textContent = btn.dataset._t || 'Post review'; }
      }
    });
  }

  function boot() {
    var page = window.LYMX_BIZ_PAGE;
    if (!page || !page.slug) {
      console.warn('[lymx-biz-reviews] no LYMX_BIZ_PAGE set on this page; skipping.');
      return;
    }
    wireStarPicker();
    wireForm(page.slug, page.name || '');
    loadReviews(page.slug);
  }

  window.LYMX_BizReviews = {
    boot: boot,
    loadReviews: loadReviews,
    getCountForSlug: async function (slug) {
      if (!window.LYMX_CONFIG || !slug) return null;
      var cfg = window.LYMX_CONFIG;
      try {
        var r = await fetch(
          cfg.SUPABASE_URL + '/rest/v1/reviews?business_slug=eq.' + encodeURIComponent(slug) +
            '&verification_status=in.(verified,pending)&select=id',
          { headers: { apikey: cfg.SUPABASE_ANON_KEY, Prefer: 'count=exact' } }
        );
        if (!r.ok) return null;
        var range = r.headers.get('content-range') || '';
        var m = range.match(/\/(\d+)$/);
        return m ? parseInt(m[1], 10) : (await r.json()).length;
      } catch (e) {
        console.warn('[lymx-biz-reviews] count failed for ' + slug, e);
        return null;
      }
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
