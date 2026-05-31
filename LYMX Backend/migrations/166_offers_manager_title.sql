-- 166_offers_manager_title.sql
-- 2026-05-31 #53b65335 - Edit-terms reverted the "Manager title" field because
-- manager_title was only used to render the letter, never stored. Add the column.
alter table public.offers add column if not exists manager_title text;
comment on column public.offers.manager_title is 'Signer title on the offer letter (e.g. Founder & CEO). Persisted so Edit-terms restores it.';
