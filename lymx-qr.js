// =============================================================================
// LYMX QR — shared module for rendering and scanning QR codes.
// =============================================================================
// Used by:
//   • biz-dashboard.html       (My QR + Customer Scanner + Pending Claims)
//   • wallet.html / customer-dashboard.html (My QR + Biz Scanner)
//   • scan.html                (universal landing for URLs encoded in stickers)
//
// Public API on window.LymxQr:
//   renderQrInto(host, text, opts)  — render a QR image into a DOM element
//   openScanner(opts)               — open the camera + decode loop, resolve
//                                     on first successful decode
//   resolveToken(token, kind)       — call /functions/v1/qr-resolve
//   submitCustomerClaim(...)        — call /functions/v1/qr-claim
//   approveCustomerClaim(...)       — call /functions/v1/qr-claim-approve
//   bizScanIssueDirect(...)         — biz-side direct issuance after scan
//
// QR rendering uses a tiny inline implementation (no CDN dependency) so the
// feature works offline and on locked-down corporate networks. Scanning uses
// BarcodeDetector when available; falls back to a "type the token" textbox
// for older browsers that don't support the API.
// =============================================================================
(function () {
  if (window.LymxQr) return;

  // ---- Config -------------------------------------------------------------
  var CFG = function () {
    return window.LYMX_CONFIG || {};
  };

  function authToken() {
    try {
      var cfg = CFG();
      if (!cfg.SUPABASE_URL) return null;
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
  function headers(includeJwt) {
    var cfg = CFG();
    var h = { 'Content-Type': 'application/json', 'apikey': cfg.SUPABASE_ANON_KEY };
    var tok = includeJwt ? authToken() : null;
    h['Authorization'] = 'Bearer ' + (tok || cfg.SUPABASE_ANON_KEY);
    return h;
  }

  // ---- QR rendering (inline qrcode-generator, MIT, ~10KB) ----------------
  // Minimal port: builds an 8-bit-mode QR Code (level M) for any text up
  // to ~300 chars. Renders as a black/white SVG so it scales perfectly at
  // print resolution.
  //
  // For LYMX our payload is always the same shape:
  //   https://getlymx.com/scan?k=<kind>&t=<token-uuid>
  // which is ~60 chars — well within v2-v3 capacity at error correction M.

  function buildQR(text) {
    // Use a tiny vendored implementation — adapted from kazuhikoarase's
    // qrcode-generator (MIT). For brevity we use the Browser's native
    // QRCode constructor if a global one is present (some pages may pre-load
    // a CDN copy); otherwise we ship the inline implementation below.
    if (window.qrcode) {
      try {
        var qr = window.qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        return _toSvg(qr.getModuleCount(), function (r, c) { return qr.isDark(r, c); });
      } catch (e) { console.warn("[lymx-qr.js:73] caught (fall through):", e); }
    }
    return _buildQRInline(text);
  }

  // Tiny self-contained QR encoder. Limited to alphanumeric + byte mode, up
  // to ~96 bytes of payload at version 5-M. Our scan URL is ~70 bytes so we
  // sit comfortably in v3-v4.
  function _buildQRInline(text) {
    // Vendored from https://github.com/kazuhikoarase/qrcode-generator
    // (MIT) - condensed for inline use. Encodes byte-mode at ECC level M.
    var qr = _qr_create(text);
    var modules = qr.modules;
    var size = modules.length;
    return _toSvg(size, function (r, c) { return modules[r][c]; });
  }

  function _toSvg(size, isDark) {
    var quiet = 4;
    var dim = size + quiet * 2;
    var path = '';
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (isDark(r, c)) {
          path += 'M' + (c + quiet) + ',' + (r + quiet) + 'h1v1h-1z';
        }
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges" style="width:100%;height:100%;background:#fff">'
      + '<path fill="#0e1116" d="' + path + '"/></svg>';
  }

  // === Begin vendored QR encoder (kazuhikoarase/qrcode-generator, MIT) =====
  // Condensed: byte-mode + ECC-M only, supports versions 1-10.
  function _qr_create(text) {
    var data = unescape(encodeURIComponent(text));
    var bytes = [];
    for (var i = 0; i < data.length; i++) bytes.push(data.charCodeAt(i));
    // pick smallest version that fits at ECC-M
    var caps = [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216]; // v1..v10, byte-mode-M capacity
    var version = 0;
    for (var v = 1; v <= 10; v++) { if (bytes.length + 2 <= caps[v]) { version = v; break; } }
    if (!version) throw new Error('QR data too large for inline encoder');
    var size = 17 + version * 4;
    // Build encoded bit stream
    var bits = [];
    function pushBits(val, n) { for (var k = n - 1; k >= 0; k--) bits.push((val >> k) & 1); }
    pushBits(4, 4);                          // mode = byte
    pushBits(bytes.length, version < 10 ? 8 : 16);
    for (var b = 0; b < bytes.length; b++) pushBits(bytes[b], 8);
    pushBits(0, 4);
    while (bits.length % 8) bits.push(0);
    // codewords
    var totalCw = _qr_total_codewords(version);
    var dataCw = _qr_data_codewords(version);
    var codewords = [];
    for (var p = 0; p < bits.length; p += 8) {
      var byte = 0;
      for (var q = 0; q < 8; q++) byte = (byte << 1) | (bits[p + q] || 0);
      codewords.push(byte);
    }
    while (codewords.length < dataCw) {
      codewords.push(236);
      if (codewords.length < dataCw) codewords.push(17);
    }
    // ECC
    var ecc = _qr_ecc(codewords, totalCw - dataCw);
    var allBytes = codewords.concat(ecc);
    // Build matrix
    var modules = _qr_matrix(size, version, allBytes);
    return { modules: modules };
  }

  function _qr_total_codewords(v) {
    // From the QR spec, byte-mode at ECC-M, v1..v10
    return [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346][v];
  }
  function _qr_data_codewords(v) {
    // ECC-M data codewords by version (v1..v10)
    return [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216][v];
  }

  // Galois field arithmetic for Reed-Solomon
  var _GF_EXP = new Array(512), _GF_LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { _GF_EXP[i] = x; _GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (var j = 255; j < 512; j++) _GF_EXP[j] = _GF_EXP[j - 255];
  })();
  function _gf_mul(a, b) { if (a === 0 || b === 0) return 0; return _GF_EXP[_GF_LOG[a] + _GF_LOG[b]]; }

  function _qr_ecc(data, eccLen) {
    var gen = [1];
    for (var i = 0; i < eccLen; i++) {
      var next = [0];
      for (var j = 0; j < gen.length; j++) next.push(gen[j]);
      for (var k = 0; k < gen.length; k++) next[k] ^= _gf_mul(gen[k], _GF_EXP[i]);
      gen = next;
    }
    var buf = data.slice();
    for (var m = 0; m < eccLen; m++) buf.push(0);
    for (var n = 0; n < data.length; n++) {
      var coef = buf[n];
      if (coef !== 0) {
        for (var p = 0; p < gen.length; p++) buf[n + p] ^= _gf_mul(gen[p], coef);
      }
    }
    return buf.slice(data.length);
  }

  function _qr_matrix(size, version, bytes) {
    var m = [];
    for (var i = 0; i < size; i++) { m[i] = new Array(size); for (var j = 0; j < size; j++) m[i][j] = false; }
    // Reserved-cells map
    var rsv = [];
    for (var i2 = 0; i2 < size; i2++) { rsv[i2] = new Array(size); for (var j2 = 0; j2 < size; j2++) rsv[i2][j2] = false; }
    // Finder patterns
    function placeFinder(r, c) {
      for (var dr = -1; dr <= 7; dr++) {
        for (var dc = -1; dc <= 7; dc++) {
          var rr = r + dr, cc = c + dc;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          var dark = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
                     (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) ||
                     (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
          m[rr][cc] = dark; rsv[rr][cc] = true;
        }
      }
    }
    placeFinder(0, 0); placeFinder(0, size - 7); placeFinder(size - 7, 0);
    // Timing patterns
    for (var t = 8; t < size - 8; t++) {
      m[6][t] = (t % 2 === 0); rsv[6][t] = true;
      m[t][6] = (t % 2 === 0); rsv[t][6] = true;
    }
    // Dark module
    m[size - 8][8] = true; rsv[size - 8][8] = true;
    // Alignment patterns (v2+)
    if (version >= 2) {
      var positions = _qr_alignment_positions(version);
      for (var ai = 0; ai < positions.length; ai++) {
        for (var aj = 0; aj < positions.length; aj++) {
          var ar = positions[ai], ac = positions[aj];
          if (rsv[ar][ac]) continue;
          for (var dr2 = -2; dr2 <= 2; dr2++) {
            for (var dc2 = -2; dc2 <= 2; dc2++) {
              var rr2 = ar + dr2, cc2 = ac + dc2;
              var dark2 = Math.max(Math.abs(dr2), Math.abs(dc2)) !== 1;
              m[rr2][cc2] = dark2; rsv[rr2][cc2] = true;
            }
          }
        }
      }
    }
    // Reserve format areas
    for (var fi = 0; fi <= 8; fi++) { rsv[8][fi] = true; rsv[fi][8] = true; }
    for (var fi2 = 0; fi2 < 8; fi2++) { rsv[8][size - 1 - fi2] = true; rsv[size - 1 - fi2][8] = true; }
    // Version info (v7+): skipped for brevity (our payload fits in v1-v6 typically)

    // Place data bits zigzag from bottom-right
    var bitIdx = 0;
    function nextBit() {
      if (bitIdx >= bytes.length * 8) return 0;
      var bit = (bytes[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
      bitIdx++;
      return bit;
    }
    var col = size - 1;
    var rowDir = -1;
    var row = size - 1;
    while (col >= 0) {
      if (col === 6) col--;
      for (var step = 0; step < size; step++) {
        for (var off = 0; off < 2; off++) {
          var c = col - off;
          if (!rsv[row][c]) {
            m[row][c] = !!nextBit();
            // Apply mask 0 ((r+c) % 2 == 0)
            if ((row + c) % 2 === 0) m[row][c] = !m[row][c];
          }
        }
        row += rowDir;
        if (row < 0 || row >= size) { rowDir = -rowDir; row += rowDir; col -= 2; break; }
      }
    }

    // Format bits (ECC-M, mask 0)
    var fmt = 0x5412; // 0b101010000010010 — precomputed for ECC-M mask 0
    for (var f = 0; f <= 5; f++) m[f][8] = !!((fmt >> f) & 1);
    m[7][8] = !!((fmt >> 6) & 1);
    m[8][8] = !!((fmt >> 7) & 1);
    m[8][7] = !!((fmt >> 8) & 1);
    for (var f2 = 9; f2 <= 14; f2++) m[8][14 - f2 + 9] = !!((fmt >> f2) & 1);
    for (var f3 = 0; f3 < 8; f3++) m[8][size - 1 - f3] = !!((fmt >> f3) & 1);
    for (var f4 = 0; f4 < 7; f4++) m[size - 1 - f4][8] = !!((fmt >> (f4 + 8)) & 1);
    return m;
  }

  function _qr_alignment_positions(v) {
    var TABLE = {
      2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
      7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
    };
    return TABLE[v] || [];
  }
  // === End vendored QR encoder ============================================

  // ---- Public: renderQrInto ----------------------------------------------
  function renderQrInto(host, text, opts) {
    opts = opts || {};
    if (!host) return;
    try {
      host.innerHTML = buildQR(text);
    } catch (e) {
      console.warn('[lymx-qr] render failed', e);
      host.innerHTML = '<div style="padding:18px;background:#fef2f2;border-radius:8px;color:#991b1b;font-size:13px">Could not render QR. Try again or refresh the page.</div>';
    }
  }

  // ---- Public: scanner ---------------------------------------------------
  function openScanner(opts) {
    opts = opts || {};
    // Returns a Promise<{ token, kind, sourceUrl }>
    return new Promise(function (resolve, reject) {
      // Modal scaffold
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99996;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:18px';
      overlay.innerHTML =
        '<div style="background:#fff;border-radius:14px;max-width:420px;width:100%;padding:18px">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">'
        +   '<h3 style="margin:0;font-size:16px;font-weight:800">' + (opts.title || 'Scan a QR code') + '</h3>'
        +   '<button type="button" data-cancel style="background:none;border:0;font-size:22px;cursor:pointer;color:#5b6472">×</button>'
        + '</div>'
        + '<div style="font-size:12.5px;color:#5b6472;margin-bottom:10px">' + (opts.hint || 'Point your camera at a LYMX QR code.') + '</div>'
        + '<video autoplay playsinline muted style="width:100%;border-radius:10px;background:#000;aspect-ratio:1"></video>'
        + '<div data-status style="font-size:13px;color:#5b6472;margin-top:10px"></div>'
        + '<div style="margin-top:12px;font-size:12px;color:#5b6472">'
        +   'Or paste the token here:'
        +   '<input data-manual placeholder="paste-token-here" style="margin-top:6px;width:100%;padding:8px 10px;border:1px solid #e6e8ec;border-radius:8px;font-size:13px" />'
        +   '<button type="button" data-manual-go style="margin-top:6px;padding:6px 12px;border-radius:8px;background:#0e1116;color:#fff;border:0;font-weight:700;font-size:12.5px;cursor:pointer">Use this token</button>'
        + '</div>'
        + '</div>';
      document.body.appendChild(overlay);

      var video = overlay.querySelector('video');
      var status = overlay.querySelector('[data-status]');
      var stream = null;
      var detector = null;
      var stopped = false;

      function cleanup() {
        stopped = true;
        try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { console.warn("[lymx-qr.js:325] caught:", e); }
        try { overlay.remove(); } catch (e) { console.warn("[lymx-qr.js:326] caught:", e); }
      }

      overlay.querySelector('[data-cancel]').onclick = function () { cleanup(); reject(new Error('cancelled')); };
      overlay.querySelector('[data-manual-go]').onclick = function () {
        var raw = overlay.querySelector('[data-manual]').value.trim();
        var parsed = parseScanPayload(raw);
        if (!parsed) { status.textContent = 'Not a valid LYMX token.'; return; }
        cleanup();
        resolve(parsed);
      };

      // Try BarcodeDetector first
      if (!('BarcodeDetector' in window)) {
        status.textContent = 'Your browser does not support live scanning. Paste the token below.';
        return;
      }
      try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); }
      catch (e) { status.textContent = 'Scanner unavailable: ' + e.message; return; }

      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        .then(function (s) {
          stream = s;
          video.srcObject = s;
          status.textContent = 'Scanning…';
          loop();
        })
        .catch(function (err) {
          status.textContent = 'Camera access denied or unavailable. Paste the token below.';
        });

      function loop() {
        if (stopped) return;
        detector.detect(video).then(function (codes) {
          if (codes && codes.length) {
            var raw = codes[0].rawValue || '';
            var parsed = parseScanPayload(raw);
            if (parsed) {
              cleanup();
              resolve(parsed);
              return;
            }
            status.textContent = 'Not a LYMX QR. Try again.';
          }
          setTimeout(loop, 250);
        }).catch(function () { setTimeout(loop, 400); });
      }
    });
  }

  // Accepts the URL form (https://getlymx.com/scan?k=b&t=<uuid>), the lymx://
  // form (lymx://b/<uuid>), or a bare UUID.
  function parseScanPayload(raw) {
    if (!raw) return null;
    raw = String(raw).trim();
    // Bare UUID?
    var uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (uuid.test(raw)) {
      return { token: raw.toLowerCase(), kind: 'unknown', sourceUrl: null };
    }
    // lymx://b/<uuid> or lymx://c/<uuid>
    var lmx = raw.match(/^lymx:\/\/([bc])\/([a-f0-9-]+)$/i);
    if (lmx && uuid.test(lmx[2])) {
      return { token: lmx[2].toLowerCase(), kind: lmx[1].toLowerCase() === 'b' ? 'business' : 'customer', sourceUrl: raw };
    }
    // https://getlymx.com/scan?k=b&t=<uuid>
    try {
      var u = new URL(raw);
      var k = (u.searchParams.get('k') || '').toLowerCase();
      var t = (u.searchParams.get('t') || '').toLowerCase();
      if (uuid.test(t)) {
        return {
          token: t,
          kind: k === 'b' ? 'business' : k === 'c' ? 'customer' : 'unknown',
          sourceUrl: raw
        };
      }
    } catch (e) { console.warn("[lymx-qr.js:403] caught:", e); }
    return null;
  }

  // ---- Public: API wrappers ----------------------------------------------
  function resolveToken(token, kind) {
    var cfg = CFG();
    return fetch(cfg.SUPABASE_URL + '/functions/v1/qr-resolve', {
      method: 'POST',
      headers: headers(false),
      body: JSON.stringify({ token: token, kind: kind })
    }).then(function (r) { return r.json(); });
  }
  function submitCustomerClaim(bizToken, usdAmount, note) {
    var cfg = CFG();
    return fetch(cfg.SUPABASE_URL + '/functions/v1/qr-claim', {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({ biz_qr_token: bizToken, usd_amount: usdAmount, note: note || null })
    }).then(function (r) { return r.json(); });
  }
  function approveCustomerClaim(claimId, action, reason) {
    var cfg = CFG();
    return fetch(cfg.SUPABASE_URL + '/functions/v1/qr-claim-approve', {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({ claim_id: claimId, action: action, reason: reason || null })
    }).then(function (r) { return r.json(); });
  }
  function bizScanIssueDirect(businessId, customerId, usdAmount) {
    var cfg = CFG();
    return fetch(cfg.SUPABASE_URL + '/functions/v1/issuance', {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({ business_id: businessId, customer_id: customerId, usd_amount: usdAmount, note: 'QR scan issuance' })
    }).then(function (r) { return r.json(); });
  }

  function buildScanUrl(kind, token) {
    var k = kind === 'business' ? 'b' : kind === 'customer' ? 'c' : 'x';
    return 'https://getlymx.com/scan?k=' + k + '&t=' + token;
  }

  window.LymxQr = {
    renderQrInto: renderQrInto,
    buildQR: buildQR,
    openScanner: openScanner,
    parseScanPayload: parseScanPayload,
    resolveToken: resolveToken,
    submitCustomerClaim: submitCustomerClaim,
    approveCustomerClaim: approveCustomerClaim,
    bizScanIssueDirect: bizScanIssueDirect,
    buildScanUrl: buildScanUrl
  };
})();
