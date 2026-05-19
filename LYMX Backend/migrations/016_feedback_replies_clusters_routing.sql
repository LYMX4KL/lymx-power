-- =============================================================================
-- Migration 016 — Feedback replies + keyword clusters + category routing
-- =============================================================================
-- Adds full bug-verification workflow (mirrors InvestPro PM pattern):
--   - feedback_replies: admin replies + submitter responses
--   - feedback_keyword_clusters: regex-driven auto-tagging
--   - feedback_category_routing: operator-configurable category → assignee
--   - verification_token on feedback for public no-login verify links
--   - v_my_feedback view for the submitter's own portal
-- =============================================================================

-- =====================================================================
-- 1. Extend feedback table with verification + tagging columns
-- =====================================================================
alter table public.feedback
    add column if not exists verification_token            uuid,
    add column if not exists verification_token_used_at    timestamptz,
    add column if not exists awaiting_verification         boolean not null default false,
    add column if not exists cluster_key                   text,
    add column if not exists auto_tags                     jsonb default '[]'::jsonb,
    add column if not exists reply_count                   int not null default 0,
    add column if not exists last_reply_at                 timestamptz,
    add column if not exists last_reply_kind               text,
    add column if not exists submitter_notified_at         timestamptz;

create unique index if not exists idx_feedback_verification_token on public.feedback(verification_token) where verification_token is not null;
create index if not exists idx_feedback_cluster_key   on public.feedback(cluster_key);
create index if not exists idx_feedback_awaiting     on public.feedback(awaiting_verification) where awaiting_verification = true;

-- =====================================================================
-- 2. feedback_replies — admin replies + submitter verifications
-- =====================================================================
create table if not exists public.feedback_replies (
    id              uuid primary key default uuid_generate_v4(),
    feedback_id     uuid not null references public.feedback(id) on delete cascade,
    author_id       uuid references auth.users(id) on delete set null,
    author_name     text,
    author_email    text,
    author_role     text,
    kind            text not null check (kind in ('admin_response','submitter_response','system')),
    body_text       text not null check (char_length(body_text) >= 1),
    asks_verification     boolean not null default false,
    verification_status   text check (verification_status in ('confirmed','still_broken') or verification_status is null),
    verified_at     timestamptz,
    email_sent_at   timestamptz,
    email_message_id text,
    created_at      timestamptz not null default now()
);

create index if not exists idx_feedback_replies_feedback on public.feedback_replies(feedback_id, created_at desc);
create index if not exists idx_feedback_replies_author   on public.feedback_replies(author_id);

-- Trigger: bump reply_count + last_reply_* on feedback when a reply lands
create or replace function public.bump_feedback_reply_denorm()
returns trigger language plpgsql as $$
begin
    update public.feedback
       set reply_count = reply_count + 1,
           last_reply_at = new.created_at,
           last_reply_kind = new.kind
     where id = new.feedback_id;
    return new;
end;
$$;

drop trigger if exists feedback_reply_denorm on public.feedback_replies;
create trigger feedback_reply_denorm
    after insert on public.feedback_replies
    for each row execute function public.bump_feedback_reply_denorm();

-- =====================================================================
-- 3. feedback_keyword_clusters — regex-driven auto-tagging
-- =====================================================================
create table if not exists public.feedback_keyword_clusters (
    cluster_key     text primary key,
    display_name    text not null,
    emoji           text default '📋',
    regex_pattern   text not null,
    is_active       boolean not null default true,
    sort_order      int not null default 100,
    created_at      timestamptz not null default now()
);

-- Trigger: auto-populate cluster_key + auto_tags on insert/update
create or replace function public.feedback_auto_tag()
returns trigger language plpgsql as $$
declare
    cluster record;
    matches jsonb := '[]'::jsonb;
    first_match text := null;
    haystack text;
begin
    haystack := coalesce(new.subject, '') || ' ' || coalesce(new.message, '');
    for cluster in
        select cluster_key, regex_pattern
          from public.feedback_keyword_clusters
         where is_active = true
         order by sort_order asc
    loop
        if haystack ~* cluster.regex_pattern then
            matches := matches || to_jsonb(cluster.cluster_key);
            if first_match is null then first_match := cluster.cluster_key; end if;
        end if;
    end loop;
    new.auto_tags := matches;
    if new.cluster_key is null then new.cluster_key := first_match; end if;
    return new;
end;
$$;

drop trigger if exists feedback_auto_tag_trigger on public.feedback;
create trigger feedback_auto_tag_trigger
    before insert or update of message, subject on public.feedback
    for each row execute function public.feedback_auto_tag();

-- Seed initial clusters (LYMX-relevant)
insert into public.feedback_keyword_clusters (cluster_key, display_name, emoji, regex_pattern, sort_order)
values
    ('auth',           'Login / Auth',          '🔐', '\m(login|sign[ -]?in|sign[ -]?up|password|reset|locked|auth|2fa)\M', 10),
    ('wallet',         'Wallet / Balance',      '💰', '\m(wallet|balance|lymx|credit|deduct|spend)\M', 20),
    ('signup_bonus',   'Signup bonus',          '🎁', '\m(bonus|welcome|signup\s*bonus|new\s*user|promo)\M', 25),
    ('biz_dashboard',  'Business dashboard',    '🏪', '\m(biz|business\s*dashboard|merchant|owner\s*portal)\M', 30),
    ('partner_portal', 'Partner / Downline',    '🤝', '\m(partner|downline|commission|generation|referral)\M', 35),
    ('payments',       'Payments / Billing',    '💳', '\m(invoice|billing|charge|stripe|payment|refund)\M', 40),
    ('email',          'Email / Notifications', '📧', '\m(email|notification|invite|broadcast|spam)\M', 45),
    ('mobile',         'Mobile / Responsive',   '📱', '\m(mobile|phone|tablet|responsive|tiny|small\s*screen)\M', 50),
    ('ui_visual',      'UI / Visual',           '🎨', '\m(layout|colors?|font|alignment|button|design|broken\s*image|css)\M', 55),
    ('performance',    'Performance / Slow',    '⚡', '\m(slow|lag|loading|timeout|crash|freeze|hang)\M', 60),
    ('integrations',   'Integrations / API',    '🔌', '\m(api|webhook|integration|square|toast|clover|stripe|investpro|buildium)\M', 65),
    ('feature_request','Feature request',       '💡', '\m(add|wish|would\s*love|could\s*you|feature|suggestion)\M', 90),
    ('praise',         'Praise / Compliment',   '⭐', '\m(love|great|awesome|amazing|thank|appreciate)\M', 95)
on conflict (cluster_key) do nothing;

-- =====================================================================
-- 4. feedback_category_routing — operator-configurable category → assignee
-- =====================================================================
-- When new feedback comes in with a given cluster_key OR type, auto-assign to
-- the staff user in this routing table. Marketing/admin can edit via UI.
create table if not exists public.feedback_category_routing (
    id              uuid primary key default uuid_generate_v4(),
    match_type      text not null check (match_type in ('cluster','type','role','any')),
    match_value     text not null,                       -- 'auth', 'bug', 'customer', '*'
    assigned_to     uuid references auth.users(id) on delete set null,
    priority_override text check (priority_override in ('urgent','high','normal','low') or priority_override is null),
    notes           text,
    active          boolean not null default true,
    sort_order      int not null default 100,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index if not exists idx_feedback_routing_active on public.feedback_category_routing(active, sort_order) where active = true;

-- Trigger: auto-assign new feedback based on routing rules
create or replace function public.feedback_auto_route()
returns trigger language plpgsql as $$
declare
    rule record;
begin
    if new.assigned_to is not null then return new; end if;  -- already manually assigned

    -- Try cluster match first
    if new.cluster_key is not null then
        select * into rule
          from public.feedback_category_routing
         where active = true
           and match_type = 'cluster'
           and match_value = new.cluster_key
         order by sort_order asc
         limit 1;
        if found then
            new.assigned_to := rule.assigned_to;
            new.assigned_at := now();
            if rule.priority_override is not null then new.priority := rule.priority_override; end if;
            return new;
        end if;
    end if;

    -- Then type
    select * into rule
      from public.feedback_category_routing
     where active = true
       and match_type = 'type'
       and match_value = new.type
     order by sort_order asc
     limit 1;
    if found then
        new.assigned_to := rule.assigned_to;
        new.assigned_at := now();
        if rule.priority_override is not null then new.priority := rule.priority_override; end if;
        return new;
    end if;

    -- Then role
    if new.user_role is not null then
        select * into rule
          from public.feedback_category_routing
         where active = true
           and match_type = 'role'
           and match_value = new.user_role
         order by sort_order asc
         limit 1;
        if found then
            new.assigned_to := rule.assigned_to;
            new.assigned_at := now();
            return new;
        end if;
    end if;

    -- Catch-all
    select * into rule
      from public.feedback_category_routing
     where active = true
       and match_type = 'any'
     order by sort_order asc
     limit 1;
    if found then
        new.assigned_to := rule.assigned_to;
        new.assigned_at := now();
    end if;

    return new;
end;
$$;

drop trigger if exists feedback_auto_route_trigger on public.feedback;
create trigger feedback_auto_route_trigger
    before insert on public.feedback
    for each row execute function public.feedback_auto_route();

-- Seed default catch-all: route everything to Kenny until he adds staff
insert into public.feedback_category_routing (match_type, match_value, assigned_to, notes, sort_order)
values ('any', '*', '1405bb50-2c97-48dd-bfa5-31f32320de9b'::uuid, 'Default: all unrouted feedback goes to founder', 999)
on conflict do nothing;

-- =====================================================================
-- 5. v_my_feedback view — submitter's own portal
-- =====================================================================
create or replace view public.v_my_feedback as
select
    f.id, f.type, f.priority, f.subject, f.message, f.status,
    f.cluster_key, f.auto_tags, f.reply_count, f.last_reply_at, f.last_reply_kind,
    f.awaiting_verification, f.verification_token, f.created_at, f.resolved_at,
    f.page_url,
    (select count(*) from public.feedback_replies r
       where r.feedback_id = f.id and r.kind = 'admin_response')::int as admin_reply_count,
    (select r.body_text from public.feedback_replies r
       where r.feedback_id = f.id and r.kind = 'admin_response'
       order by r.created_at desc limit 1) as last_admin_reply_text,
    (select r.created_at from public.feedback_replies r
       where r.feedback_id = f.id and r.kind = 'admin_response'
       order by r.created_at desc limit 1) as last_admin_reply_at
from public.feedback f
where f.user_id = auth.uid()
   or auth.uid() = '1405bb50-2c97-48dd-bfa5-31f32320de9b'::uuid;

grant select on public.v_my_feedback to authenticated;

-- =====================================================================
-- 6. RLS for feedback_replies + clusters + routing
-- =====================================================================
alter table public.feedback_replies         enable row level security;
alter table public.feedback_keyword_clusters enable row level security;
alter table public.feedback_category_routing enable row level security;

-- feedback_replies: submitter sees their own thread, admin sees all, staff with role can read
drop policy if exists fb_replies_admin_all on public.feedback_replies;
create policy fb_replies_admin_all on public.feedback_replies for all to authenticated
    using (public.am_i_admin()) with check (public.am_i_admin());

drop policy if exists fb_replies_submitter_read on public.feedback_replies;
create policy fb_replies_submitter_read on public.feedback_replies for select to authenticated
    using (exists (
        select 1 from public.feedback f
         where f.id = feedback_replies.feedback_id and f.user_id = auth.uid()
    ));

drop policy if exists fb_replies_staff_read on public.feedback_replies;
create policy fb_replies_staff_read on public.feedback_replies for select to authenticated
    using (public.has_staff_role('support') or public.has_staff_role('tech'));

drop policy if exists fb_replies_staff_insert on public.feedback_replies;
create policy fb_replies_staff_insert on public.feedback_replies for insert to authenticated
    with check (
        (public.has_staff_role('support') or public.has_staff_role('tech') or public.am_i_admin())
        and author_id = auth.uid()
    );

grant select, insert, update on public.feedback_replies to authenticated;

-- clusters: public read (so the widget can show category dropdown), admin write
drop policy if exists fb_clusters_public_read on public.feedback_keyword_clusters;
create policy fb_clusters_public_read on public.feedback_keyword_clusters for select to authenticated, anon
    using (is_active = true);

drop policy if exists fb_clusters_admin_all on public.feedback_keyword_clusters;
create policy fb_clusters_admin_all on public.feedback_keyword_clusters for all to authenticated
    using (public.am_i_admin()) with check (public.am_i_admin());

grant select on public.feedback_keyword_clusters to anon, authenticated;
grant insert, update, delete on public.feedback_keyword_clusters to authenticated;

-- routing: admin all, staff read
drop policy if exists fb_routing_admin_all on public.feedback_category_routing;
create policy fb_routing_admin_all on public.feedback_category_routing for all to authenticated
    using (public.am_i_admin()) with check (public.am_i_admin());

drop policy if exists fb_routing_staff_read on public.feedback_category_routing;
create policy fb_routing_staff_read on public.feedback_category_routing for select to authenticated
    using (public.my_staff_role() is not null);

grant select, insert, update, delete on public.feedback_category_routing to authenticated;

-- =====================================================================
-- 7. Verify
-- =====================================================================
select 'feedback_replies'           as t, count(*) from public.feedback_replies
union all select 'feedback_keyword_clusters', count(*) from public.feedback_keyword_clusters
union all select 'feedback_category_routing', count(*) from public.feedback_category_routing
union all select 'v_my_feedback (cols)', (select count(*) from information_schema.columns where table_schema='public' and table_name='v_my_feedback');

-- =============================================================================
-- End of migration 016
-- =============================================================================
