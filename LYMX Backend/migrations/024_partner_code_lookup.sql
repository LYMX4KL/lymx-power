-- =============================================================================
-- Migration 024 — Partner code (P-NNNNNN) for sponsor lookup
-- =============================================================================
-- Kenny 2026-05-14: "my code was not valid either when she sign up from my
-- invite". Root cause: partner-signup Edge Function does `.eq("id", sid)`
-- where sid is "P-000001" (P-NNNNNN format), but `id` is a UUID — never matches.
--
-- Fix: add a `partner_code` column with auto-generation, backfill existing rows,
-- index for lookup. The Edge Function update (separate file) supports lookup by
-- either UUID or partner_code.
--
-- Code format:
--   - Founding 25 (rank 1–25) → P-000001 .. P-000025
--   - Everyone else           → P-000100 onwards (sequence)
--
-- Idempotent.
-- =============================================================================

-- =====================================================================
-- 1. Add column + sequence
-- =====================================================================
alter table public.partners
    add column if not exists partner_code text;

create sequence if not exists public.partner_code_seq start with 100;

-- =====================================================================
-- 2. Trigger to auto-generate partner_code on insert
-- =====================================================================
create or replace function public.generate_partner_code()
returns trigger
language plpgsql
as $$
declare
    v_seq int;
begin
    if NEW.partner_code is not null and NEW.partner_code <> '' then
        return NEW;
    end if;
    if NEW.is_founding_25 = true and NEW.founding_25_rank between 1 and 25 then
        NEW.partner_code := 'P-' || lpad(NEW.founding_25_rank::text, 6, '0');
    else
        v_seq := nextval('public.partner_code_seq');
        NEW.partner_code := 'P-' || lpad(v_seq::text, 6, '0');
    end if;
    return NEW;
end;
$$;

drop trigger if exists trg_partners_code on public.partners;
create trigger trg_partners_code
    before insert on public.partners
    for each row execute function public.generate_partner_code();

-- =====================================================================
-- 3. Backfill existing rows
-- =====================================================================
-- Founding 25 first (deterministic from rank)
update public.partners
   set partner_code = 'P-' || lpad(founding_25_rank::text, 6, '0')
 where (partner_code is null or partner_code = '')
   and is_founding_25 = true
   and founding_25_rank between 1 and 25;

-- Everyone else gets the next sequence value
do $$
declare r record;
begin
    for r in select id from public.partners
              where partner_code is null or partner_code = ''
              order by created_at
    loop
        update public.partners
           set partner_code = 'P-' || lpad(nextval('public.partner_code_seq')::text, 6, '0')
         where id = r.id;
    end loop;
end$$;

-- =====================================================================
-- 4. Constraints + index AFTER backfill (so unique doesn't fail mid-backfill)
-- =====================================================================
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'partners_partner_code_unique') then
        alter table public.partners
            add constraint partners_partner_code_unique unique (partner_code);
    end if;
end$$;

create index if not exists idx_partners_partner_code on public.partners(partner_code);

-- =====================================================================
-- 5. lookup_partner_by_code helper (used by partner-signup Edge Function)
-- =====================================================================
create or replace function public.lookup_partner_by_code(p_code text)
returns uuid
language sql
stable
security definer
as $$
    select id from public.partners
     where partner_code = upper(p_code)
     limit 1;
$$;

grant execute on function public.lookup_partner_by_code(text) to anon, authenticated;

-- =====================================================================
-- 6. Verify
-- =====================================================================
select 'migration 024 applied' as status,
       (select count(*) from public.partners where partner_code is not null) as coded,
       (select count(*) from public.partners) as total,
       (select partner_code from public.partners where user_id = '1405bb50-2c97-48dd-bfa5-31f32320de9b') as kenny_code;
