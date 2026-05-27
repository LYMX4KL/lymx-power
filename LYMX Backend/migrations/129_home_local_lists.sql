-- =============================================================================
-- 129_home_local_lists.sql
-- Home-page discovery sections: "Top-rated local" + "New local" rotating.
-- 2026-05-27 — Kenny tasks F + G.
--
-- Two SECURITY DEFINER RPCs return the home-page card data, both with
-- optional ZIP-prefix filtering so logged-in customers see neighborhood
-- merchants and anonymous visitors see the network-wide list. Frontend
-- (index.html) pulls the user's customers.home_zip via lymx-auth.js,
-- passes the first 3 digits to both RPCs, and renders cards.
--
-- Filters baked in to BOTH:
--   - businesses.archived_at IS NULL
--   - businesses.demo_only   = false
--   - businesses.approval_status = 'approved'
--   - businesses.local_blast_sent_at IS NOT NULL  (means owner has Published)
--     -- so empty just-approved pages don't appear on the home page
--
-- =============================================================================

set local statement_timeout = 0;


-- -----------------------------------------------------------------------------
-- 1. Top-rated local — by review_count desc, avg_rating desc (tiebreaker)
-- -----------------------------------------------------------------------------
-- A business needs at least 3 reviews to appear. Without this floor the
-- list would be dominated by random one-off 5-star reviews.

drop function if exists public.fn_top_rated_local_businesses(text, int);

create or replace function public.fn_top_rated_local_businesses(
    p_zip_prefix text default null,
    p_limit      int  default 10
)
returns table (
    slug          text,
    display_name  text,
    category      text,
    emoji         text,
    tagline       text,
    primary_zip   text,
    review_count  bigint,
    avg_rating    numeric,
    approved_at   timestamptz,
    hero_photo_path text
)
language sql
security definer
stable
set search_path = public, pg_temp
as $fn_top_rated$
    with biz_pool as (
        select b.id, b.slug, b.display_name, b.category, b.emoji, b.tagline, b.approved_at
          from public.businesses b
         where b.archived_at IS NULL
           and b.demo_only = false
           and b.approval_status = 'approved'
           and b.local_blast_sent_at is not null
    ),
    biz_loc as (
        select bp.*,
               (select bl.zip
                  from public.business_locations bl
                 where bl.business_id = bp.id
                   and bl.zip is not null and bl.zip <> ''
                 order by bl.is_primary desc, bl.created_at asc
                 limit 1) as primary_zip
          from biz_pool bp
    ),
    filtered as (
        select bl.*
          from biz_loc bl
         where p_zip_prefix is null
            or coalesce(bl.primary_zip, '') = ''
            or substring(regexp_replace(bl.primary_zip, '[^0-9]', '', 'g')
                         from 1 for length(p_zip_prefix))
               = p_zip_prefix
    ),
    rated as (
        select f.slug, f.display_name, f.category, f.emoji, f.tagline,
               f.primary_zip, f.approved_at, f.id,
               count(r.id)::bigint as review_count,
               coalesce(avg(r.rating), 0)::numeric(3,2) as avg_rating
          from filtered f
          left join public.reviews r on r.business_slug = f.slug
         group by f.id, f.slug, f.display_name, f.category, f.emoji, f.tagline,
                  f.primary_zip, f.approved_at
        having count(r.id) >= 3
    )
    select
        ra.slug,
        ra.display_name,
        ra.category,
        ra.emoji,
        ra.tagline,
        ra.primary_zip,
        ra.review_count,
        ra.avg_rating,
        ra.approved_at,
        (select bp.file_path
           from public.business_photos bp
          where bp.business_id = ra.id
            and bp.archived_at is null
          order by bp.display_order asc, bp.uploaded_at asc
          limit 1) as hero_photo_path
      from rated ra
     order by ra.review_count desc, ra.avg_rating desc, ra.approved_at asc
     limit greatest(coalesce(p_limit, 10), 1);
$fn_top_rated$;

revoke all on function public.fn_top_rated_local_businesses(text, int) from public;
grant execute on function public.fn_top_rated_local_businesses(text, int) to anon, authenticated, service_role;

comment on function public.fn_top_rated_local_businesses(text, int) is
    'Home-page "Top rated local" RPC. Min 3 reviews. ZIP-prefix filter optional. Returns slug+meta+rating+hero photo path.';


-- -----------------------------------------------------------------------------
-- 2. New local — businesses published in the last N days, randomized order
-- -----------------------------------------------------------------------------
-- "Published" = local_blast_sent_at IS NOT NULL within last N days. This
-- keeps the section meaningful (owner has filled out their page) rather
-- than showing empty just-approved storefronts.

drop function if exists public.fn_new_local_businesses(text, int, int);

create or replace function public.fn_new_local_businesses(
    p_zip_prefix text default null,
    p_days       int  default 30,
    p_limit      int  default 12
)
returns table (
    slug              text,
    display_name      text,
    category          text,
    emoji             text,
    tagline           text,
    primary_zip       text,
    blast_sent_at     timestamptz,
    days_since_launch int,
    hero_photo_path   text
)
language sql
security definer
stable
set search_path = public, pg_temp
as $fn_new_local$
    with biz_pool as (
        select b.id, b.slug, b.display_name, b.category, b.emoji, b.tagline,
               b.local_blast_sent_at
          from public.businesses b
         where b.archived_at IS NULL
           and b.demo_only = false
           and b.approval_status = 'approved'
           and b.local_blast_sent_at is not null
           and b.local_blast_sent_at >= now() - (greatest(coalesce(p_days, 30), 1) || ' days')::interval
    ),
    biz_loc as (
        select bp.*,
               (select bl.zip
                  from public.business_locations bl
                 where bl.business_id = bp.id
                   and bl.zip is not null and bl.zip <> ''
                 order by bl.is_primary desc, bl.created_at asc
                 limit 1) as primary_zip
          from biz_pool bp
    ),
    filtered as (
        select bl.*
          from biz_loc bl
         where p_zip_prefix is null
            or coalesce(bl.primary_zip, '') = ''
            or substring(regexp_replace(bl.primary_zip, '[^0-9]', '', 'g')
                         from 1 for length(p_zip_prefix))
               = p_zip_prefix
    )
    select
        f.slug,
        f.display_name,
        f.category,
        f.emoji,
        f.tagline,
        f.primary_zip,
        f.local_blast_sent_at as blast_sent_at,
        extract(day from (now() - f.local_blast_sent_at))::int as days_since_launch,
        (select bp.file_path
           from public.business_photos bp
          where bp.business_id = f.id
            and bp.archived_at is null
          order by bp.display_order asc, bp.uploaded_at asc
          limit 1) as hero_photo_path
      from filtered f
     order by random()
     limit greatest(coalesce(p_limit, 12), 1);
$fn_new_local$;

revoke all on function public.fn_new_local_businesses(text, int, int) from public;
grant execute on function public.fn_new_local_businesses(text, int, int) to anon, authenticated, service_role;

comment on function public.fn_new_local_businesses(text, int, int) is
    'Home-page "New local" RPC. Published in last N days (default 30), randomized. ZIP-prefix filter optional.';

-- =============================================================================
-- END mig 129
-- =============================================================================
