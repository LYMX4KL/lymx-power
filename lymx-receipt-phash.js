// lymx-receipt-phash.js
// ============================================================================
// Helper for the customer-side receipt-scan path (review-write.html and any
// future receipt-upload page).  Computes a SHA-256 hash of the receipt photo
// bytes so migration 053's dedupe constraint can reject duplicates at insert
// time.
//
// Why SHA-256 and not a perceptual hash?  Two reasons:
//   1. SHA-256 is in the standard Web Crypto API — no library, no CDN, works
//      on every modern browser including iOS Safari.
//   2. For v1 we want to catch the exact-bytes case (same photo file shared
//      between two accounts).  Perceptual hash (slight crops, resaved JPEGs)
//      is Phase 2 — install a small JS pHash library when we have data
//      showing it's needed.
//
// Usage from any page:
//   <script src="lymx-receipt-phash.js" defer></script>
//   ...
//   const phash = await LymxReceiptPhash.compute(fileBlob);
//   await sb.from('reviews').insert({ ..., receipt_phash: phash });
//
// If `reviews` already has a row with the same (business_slug, receipt_phash),
// the insert fails with HTTP 409 / Postgres unique violation. The UI should
// catch that error and show a friendly "this receipt has already been
// submitted" message instead of a generic save error.
// ============================================================================

(function () {
  if (window.LymxReceiptPhash) return; // idempotent

  async function sha256Hex(arrayBuffer) {
    const hashBuf = await crypto.subtle.digest('SHA-256', arrayBuffer);
    return Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  async function compute(fileOrBlob) {
    if (!fileOrBlob) throw new Error('lymx-receipt-phash: no file/blob');
    if (!crypto || !crypto.subtle || !crypto.subtle.digest) {
      throw new Error('lymx-receipt-phash: Web Crypto SubtleCrypto not available (need HTTPS context)');
    }
    const buf = await fileOrBlob.arrayBuffer();
    return sha256Hex(buf);
  }

  // Helper: error message classifier so callers can show a clean toast on
  // dedupe collision instead of a database error string.
  function isDuplicate(error) {
    if (!error) return false;
    const msg = (error.message || '').toString().toLowerCase();
    return /receipt_phash|duplicate key|unique constraint/.test(msg);
  }

  // Friendly explanation strings (use i18n keys later if needed)
  const messages = {
    'en':    'This receipt has already been submitted by someone. If you believe this is a mistake, contact support.',
    'es':    'Este recibo ya fue enviado por alguien. Si crees que es un error, contacta a soporte.',
    'zh-CN': '这张收据已被他人提交。如有错误请联系支持。'
  };
  function explain(locale) {
    return messages[locale] || messages['en'];
  }

  window.LymxReceiptPhash = { compute, isDuplicate, explain };
})();
