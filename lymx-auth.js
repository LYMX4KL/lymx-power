// LYMX shared auth + data helpers.
// Depends on:
//   - window.supabase (loaded via the @supabase/supabase-js CDN script)
//   - window.LYMX_CONFIG (from lymx-config.js)
//
// Pages that need auth should:
//   1. Load supabase-js + lymx-config.js + this file in <head>
//   2. Call await LYMX.requireAuth() on page load to gate the page
//   3. Use LYMX.* helpers for data fetches
//
// Auth model:
//   - All sign-ups via Supabase Auth (email + password)
//   - Customer sign-up triggers customer-wallet-create lazily (when first
//     customer interacts with a Business — handled by the Edge Function)
//   - Business sign-up uses business-signup endpoint (already wired in
//     biz-signup.html)

(function () {
  if (!window.supabase) {
    console.error('[LYMX] supabase-js not loaded. Add the CDN script before lymx-auth.js.');
    return;
  }
  if (!window.LYMX_CONFIG || !window.LYMX_CONFIG.SUPABASE_URL) {
    console.error('[LYMX] LYMX_CONFIG missing. Load lymx-config.js before lymx-auth.js.');
    return;
  }
  if (window.LYMX_CONFIG.SUPABASE_ANON_KEY === 'REPLACE_WITH_ANON_KEY') {
    console.warn('[LYMX] SUPABASE_ANON_KEY is still the placeholder. Auth calls will fail until you paste the real anon key into lymx-config.js.');
  }

  const sb = window.supabase.createClient(
    window.LYMX_CONFIG.SUPABASE_URL,
    window.LYMX_CONFIG.SUPABASE_ANON_KEY,
    { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
  );

  const LYMX = {
    sb,
    config: window.LYMX_CONFIG,

    // ---------- Auth ----------
    async getSession() {
      const { data, error } = await sb.auth.getSession();
      if (error) console.error('[LYMX] getSession', error);
      return data ? data.session : null;
    },

    async getUser() {
      const session = await this.getSession();
      return session ? session.user : null;
    },

    /**
     * Gate a page on a logged-in session.
     * @param {string} redirectTo - URL to redirect to if not signed in.
     * @returns {object|null} the user, or null if it redirected.
     */
    async requireAuth(redirectTo) {
      const session = await this.getSession();
      if (!session) {
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        const url = (redirectTo || 'login.html') + '?next=' + next;
        window.location.replace(url);
        return null;
      }
      return session.user;
    },

    async signIn(email, password) {
      return await sb.auth.signInWithPassword({ email, password });
    },

    async signUp(email, password, metadata) {
      return await sb.auth.signUp({ email, password, options: { data: metadata || {} } });
    },

    async signOut(redirectTo) {
      await sb.auth.signOut();
      window.location.replace(redirectTo || 'index.html');
    },

    /**
     * Detect role of the current user based on which extension table
     * holds their row. Returns one of: 'customer', 'business', 'partner', null.
     */
    async getRole() {
      const user = await this.getUser();
      if (!user) return null;
      const checks = [
        { tbl: 'businesses', role: 'business' },
        { tbl: 'partners', role: 'partner' },
        { tbl: 'customers', role: 'customer' }
      ];
      for (const c of checks) {
        const { data } = await sb.from(c.tbl).select('id').eq('user_id', user.id).maybeSingle();
        if (data) return c.role;
      }
      return null;
    },

    // ---------- Customer data ----------
    /**
     * Fetch every wallet this customer has across all Businesses.
     * Each row: { id, customer_id, business_id, lymx_balance, businesses: { display_name, category } }
     */
    async fetchMyWallets() {
      const user = await this.getUser();
      if (!user) return { data: [], error: new Error('Not signed in') };
      const { data: customer } = await sb.from('customers').select('id').eq('user_id', user.id).maybeSingle();
      if (!customer) return { data: [], error: null };
      return await sb
        .from('wallets')
        .select('id, business_id, lymx_balance, businesses(display_name, category)')
        .eq('customer_id', customer.id);
    },

    async fetchMyTransactions(limit) {
      const user = await this.getUser();
      if (!user) return { data: [], error: new Error('Not signed in') };
      const { data: customer } = await sb.from('customers').select('id').eq('user_id', user.id).maybeSingle();
      if (!customer) return { data: [], error: null };
      return await sb
        .from('transactions')
        .select('id, type, lymx_amount, usd_amount, created_at, business_id, businesses(display_name)')
        .eq('customer_id', customer.id)
        .order('created_at', { ascending: false })
        .limit(limit || 20);
    },

    // ---------- Business data ----------
    /**
     * Get the Business row for the signed-in user (if they ARE a Business owner).
     */
    async fetchMyBusiness() {
      const user = await this.getUser();
      if (!user) return { data: null, error: new Error('Not signed in') };
      return await sb
        .from('businesses')
        .select('id, display_name, legal_name, category, issuance_rate, contact_email')
        .eq('user_id', user.id)
        .maybeSingle();
    },

    async fetchMyBusinessTransactions(businessId, fromDate, limit) {
      let q = sb
        .from('transactions')
        .select('id, type, lymx_amount, usd_amount, created_at, customer_id')
        .eq('business_id', businessId)
        .order('created_at', { ascending: false })
        .limit(limit || 50);
      if (fromDate) q = q.gte('created_at', fromDate);
      return await q;
    },

    // ---------- Helpers ----------
    fmtLYMX(n) {
      const num = Number(n || 0);
      return num.toLocaleString('en-US') + ' LYMX';
    },
    fmtUSD(n) {
      const num = Number(n || 0);
      return '$' + num.toFixed(2);
    },
    fmtDate(s) {
      if (!s) return '';
      const d = new Date(s);
      return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }
  };

  window.LYMX = LYMX;
})();
