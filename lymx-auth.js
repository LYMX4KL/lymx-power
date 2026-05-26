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

    // ---------- Admin check (canonical, used by every gate) ----------
    // 2026-05-25 — root-cause replacement for hardcoded Kenny-UUID checks
    // that locked Helen (#d785fe0e) and any future admin out of gated pages.
    // Calls the am_i_admin() SQL helper (migration 015) so the rule travels
    // with the DB schema; the frontend stays a thin client.
    //
    // - checkIsAdmin()         async, hits the DB. Fails closed on error.
    // - isAdminCached()        sync, reads LYMX_is_admin from localStorage.
    //                          For code paths that can't be async (e.g.
    //                          lymx-nav.js routeFor which decides redirect
    //                          target during sign-in).
    // - refreshIsAdminCache()  async, refreshes the localStorage flag.
    //                          Called on every page load by lymx-nav.js so
    //                          the sync read stays accurate.
    async checkIsAdmin() {
      const user = await this.getUser();
      if (!user) return false;
      try {
        const { data, error } = await sb.rpc('am_i_admin');
        if (error) {
          console.warn('[LYMX.checkIsAdmin] am_i_admin RPC failed', error);
          return false; // fail closed
        }
        return !!data;
      } catch (e) {
        console.warn('[LYMX.checkIsAdmin] threw', e);
        return false;
      }
    },

    isAdminCached() {
      try {
        return localStorage.getItem('LYMX_is_admin') === '1';
      } catch (e) { return false; }
    },

    async refreshIsAdminCache() {
      const yes = await this.checkIsAdmin();
      try { localStorage.setItem('LYMX_is_admin', yes ? '1' : '0'); } catch (e) {} // bandaid-ok: localStorage write is best-effort per ARCHITECTURE-RULES.md
      return yes;
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
      // 2026-05-20 audit fix - wallets column is `balance`, not `lymx_balance`. Customer dashboard was reading 0 for all balances. (Audit Pass 3)
      return await sb
        .from('wallets')
        .select('id, business_id, balance, businesses(display_name, category)')
        .eq('customer_id', customer.id);
    },

    async fetchMyTransactions(limit) {
      const user = await this.getUser();
      if (!user) return { data: [], error: new Error('Not signed in') };
      const { data: customer } = await sb.from('customers').select('id').eq('user_id', user.id).maybeSingle();
      // 2026-05-20 #a8fc64af - was wallet-only; missed platform-issued LYMX
      // (welcome bonuses, promo bonuses) which live in lymx_issuances keyed
      // by recipient_user_id. Now merge both sources into a unified activity feed.
      const promises = [];
      // Wallet-linked transactions (per-business issuances + redemptions + transfers)
      if (customer) {
        const { data: walletsArr } = await sb.from('wallets').select('id').eq('customer_id', customer.id);
        const walletIds = (walletsArr || []).map(w => w.id);
        if (walletIds.length > 0) {
          promises.push(
            sb.from('transactions')
              .select('id, type, lymx_amount, usd_basis, created_at, business_id, wallet_id, businesses(display_name)')
              .in('wallet_id', walletIds)
              .order('created_at', { ascending: false })
              .limit(limit || 20)
              .then(r => (r.data || []).map(t => ({
                source: 'transaction',
                id: t.id, type: t.type, lymx_amount: t.lymx_amount, usd_basis: t.usd_basis,
                created_at: t.created_at, business_id: t.business_id, businesses: t.businesses,
              })))
              .catch(() => [])
          );
        }
      }
      // Platform-issued LYMX (welcome bonus, promos, referral pair)
      promises.push(
        sb.from('lymx_issuances')
          .select('id, amount_lymx, reason, created_at, business_id, businesses(display_name)')
          .eq('recipient_user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(limit || 20)
          .then(r => (r.data || []).map(i => ({
            source: 'issuance',
            id: i.id,
            type: 'issuance',
            lymx_amount: Number(i.amount_lymx || 0),
            usd_basis: null,
            created_at: i.created_at,
            business_id: i.business_id,
            businesses: i.businesses,
            reason: i.reason,
          })))
          .catch(() => [])
      );
      const both = await Promise.all(promises);
      const merged = [].concat(...both).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit || 20);
      return { data: merged, error: null };
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
        // 2026-05-24 audit fix: select the slug + auxiliary fields biz-dashboard
        // reads (slug is needed to rewrite the static brew-and-bean storefront
        // links to the owner's actual welcome.html?biz=<slug> page; the other
        // columns are read for the header subtitle, tagline, and emoji).
        .select('id, display_name, legal_name, category, issuance_rate, contact_email, slug, created_at, business_kind, approval_status, address_line1, tagline, description, emoji')
        // 2026-05-25: businesses table uses owner_user_id, not user_id.
        // Filtering by user_id returned null silently via maybeSingle(),
        // breaking biz-dashboard for every business owner.
        .eq('owner_user_id', user.id)
        .maybeSingle();
    },

    // ---------- Partner data ----------
    /**
     * Get the Partner row for the signed-in user (if they ARE a Partner).
     */
    async fetchMyPartner() {
      const user = await this.getUser();
      if (!user) return { data: null, error: new Error('Not signed in') };
      return await sb
        .from('partners')
        .select('id, partner_code, legal_name, display_name, contact_email, contact_phone, is_founding_25, founding_25_rank, qualifying_credits, signup_fee_paid, signup_fee_waived, monthly_fee_status, sponsor_partner_id, avatar_url')
        .eq('user_id', user.id)
        .maybeSingle();
    },

    /**
     * Count direct downline (partners where sponsor_partner_id = this partner's id).
     */
    async fetchMyDownlineCount(partnerId) {
      const { count, error } = await sb
        .from('partners')
        .select('id', { count: 'exact', head: true })
        .eq('sponsor_partner_id', partnerId);
      return { count: count || 0, error };
    },

    /**
     * Count Businesses signed up under this partner.
     */
    async fetchMyActivationsCount(partnerId) {
      const { count, error } = await sb
        .from('businesses')
        .select('id', { count: 'exact', head: true })
        .eq('signed_up_by_partner_id', partnerId);
      return { count: count || 0, error };
    },

    async fetchMyBusinessTransactions(businessId, fromDate, limit) {
      // 2026-05-20 audit fix - transactions has no `usd_amount` (column is `usd_basis`) and no direct `customer_id` (linked via wallet_id → wallets.customer_id). (Audit Pass 3)
      let q = sb
        .from('transactions')
        .select('id, type, lymx_amount, usd_basis, created_at, wallet_id, wallets(customer_id)')
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
