# LYMX feedback system — design spec (modeled after InvestPro Tech Support)

## What to build

Two parts that work together:

### 1. Floating "Send Feedback" button (every page)

- Pinned bottom-right on every public + authenticated page
- Style: rounded pill with 💬 icon + "Send Feedback" label, dark blue background, white text
- Click → opens a modal

**Modal form fields:**

| Field | Required | Notes |
|---|---|---|
| Type | yes | Dropdown: 🐛 Bug, 💡 Suggestion, ❓ Question, 📋 General — anything else |
| Priority | yes | Dropdown: 🔴 Urgent / 🟡 High / 🔵 Normal / ⚪ Low (default Normal) |
| Subject | optional | Auto-filled from message if blank, max 80 chars |
| Your message | yes | Textarea, min 10 chars |
| Screenshot | optional | File input, JPG/PNG, ≤ 5MB |

**Auto-included on submit (not user-visible fields):**
- `page_url` — `window.location.href` at click time
- `user_role` — from `LYMX.getRole()` (customer / business / partner / null)
- `user_id` — current `auth.users.id` if signed in, else null
- `user_email` — for follow-up
- `timestamp` — server-side `now()`
- `user_agent` + `viewport_size` — for repro

### 2. Admin Tech Support dashboard

- New page: `admin-tech-support.html` (or repurpose existing `admin-tickets.html`)
- Visible only to users where `auth.users.user_metadata.is_admin = true` (added later) — for now hard-gate to Kenny's user_id
- Auto-refreshes every 60s via `setInterval(...)` calling `LYMX.fetchFeedback()`

**Layout:**

**Top metric row** (6 cards):
- 🔴 Urgent open: `count where priority=urgent and status='new'`
- 🟡 High open: same with priority=high
- 🐛 Bugs open: `count where type=bug and status in ('new','in_progress')`
- 💡 Suggestions: `count where type=suggestion`
- ❓ Questions: `count where type=question`
- ✅ Resolved (7d): `count where status='resolved' and resolved_at >= now() - interval '7 days'`

**Clusters grid** — auto-categorize by URL pattern:

| Cluster | URL pattern |
|---|---|
| 🔒 Login / Auth | login.html, customer-signup.html, biz-signup.html, partner-signup.html |
| 🔍 Browse | browse.html |
| 🛒 Customer Wallet | customer-dashboard.html, customer-wallet.html |
| 🏪 Business Dashboard | biz-dashboard.html, biz-* (except signup) |
| 🤝 Partner Dashboard | rep-dashboard.html, territory-program.html |
| 📝 Reviews | write-review.html, biz-brew-and-bean.html#reviews etc. |
| 🌐 Marketing pages | index.html, about.html, careers.html, press.html, support.html |
| ⚙️ Admin | admin-*.html |

Each cluster card: cluster name + emoji, `N new` / `N in progress` / `N resolved` counts. Click → filter inbox.

**Inbox view** (below the clusters):
- Sortable by created_at desc, priority, status
- Each row: emoji-prefixed type, priority badge, subject, snippet of message, page URL link, user (name or "anonymous"), timestamp, status pill
- Row click → expand panel with full message, screenshot, user agent, repro info
- Action buttons: Mark in progress / Mark resolved / Reply via email

## Backend schema (migration 008_feedback.sql)

```sql
create table public.feedback (
    id              uuid primary key default uuid_generate_v4(),
    user_id         uuid references auth.users(id) on delete set null,
    user_role       text,                  -- 'customer' | 'business' | 'partner' | 'anonymous'
    user_email      text,                  -- for follow-up; copied at submit time

    type            text not null check (type in ('bug','suggestion','question','general')),
    priority        text not null default 'normal' check (priority in ('urgent','high','normal','low')),
    subject         text,
    message         text not null check (char_length(message) >= 10),

    page_url        text not null,
    cluster         text,                  -- auto-categorized server-side from page_url
    user_agent      text,
    viewport        text,                  -- e.g. '1920x1080'

    screenshot_path text,                  -- Supabase Storage path

    status          text not null default 'new' check (status in ('new','in_progress','resolved','wontfix')),
    resolved_at     timestamptz,
    resolved_by     uuid references auth.users(id),
    admin_notes     text,

    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index idx_feedback_status_priority on public.feedback(status, priority);
create index idx_feedback_cluster on public.feedback(cluster);
create index idx_feedback_user on public.feedback(user_id);

-- RLS
alter table public.feedback enable row level security;

-- Anyone authenticated can submit
create policy feedback_insert_authenticated on public.feedback
    for insert to authenticated
    with check (user_id = auth.uid() or user_id is null);

-- Anonymous via the anon key can also submit (no user_id)
create policy feedback_insert_anonymous on public.feedback
    for insert to anon
    with check (user_id is null);

-- Admins read + update everything
create policy feedback_admin_all on public.feedback
    for all to authenticated
    using (
        (auth.jwt() -> 'user_metadata' ->> 'is_admin')::boolean = true
        OR public.am_i_admin()  -- canonical admin bypass via staff_roles.role='admin'
    );

-- Storage bucket for screenshots
insert into storage.buckets (id, name, public)
values ('feedback-screenshots', 'feedback-screenshots', false);
```

## Edge Function (functions/feedback-submit/index.ts)

Accepts the modal payload, derives `cluster` from `page_url`, uploads optional screenshot to Supabase Storage, inserts row.

```typescript
// POST /functions/v1/feedback-submit
// Body: { type, priority, subject?, message, page_url, viewport, screenshot_b64? }
// Auth: anon or user JWT (both allowed; user_id auto-extracted from JWT if present)

const CLUSTER_RULES = [
  { pattern: /\/(login|.*-signup)\.html/, cluster: 'auth' },
  { pattern: /\/browse\.html/, cluster: 'browse' },
  { pattern: /\/customer-(dashboard|wallet)\.html/, cluster: 'customer_wallet' },
  { pattern: /\/biz-(dashboard|brew|oakline)/, cluster: 'business_dashboard' },
  { pattern: /\/(rep-dashboard|territory-program)/, cluster: 'partner_dashboard' },
  { pattern: /\/write-review\.html/, cluster: 'reviews' },
  { pattern: /\/admin-/, cluster: 'admin' },
];
function clusterFor(url: string): string {
  for (const r of CLUSTER_RULES) if (r.pattern.test(url)) return r.cluster;
  return 'marketing';
}
```

## Build order (estimated 3-5 hours)

1. Migration 008_feedback.sql + storage bucket setup (30 min)
2. feedback-submit Edge Function (45 min)
3. Add LYMX.submitFeedback() helper to lymx-auth.js (15 min)
4. Build the floating button + modal as a shared script `lymx-feedback.js` (60 min)
5. Inject the script into every page (existing 233 pages — use a subagent for the sed-like injection, 30 min)
6. Build admin-tech-support.html (90 min)
7. Smoke test end-to-end (30 min)

## Files I expect to create/modify

**New:**
- `LYMX Backend/migrations/008_feedback.sql`
- `LYMX Backend/functions/feedback-submit/index.ts`
- `LYMX Power/lymx-feedback.js` (modal + button)
- `LYMX Power/admin-tech-support.html` (admin inbox)

**Modified:**
- `LYMX Power/lymx-auth.js` — add `submitFeedback` and `fetchFeedback` helpers
- All ~233 HTML pages — inject `<script src="lymx-feedback.js"></script>` before `</body>`
