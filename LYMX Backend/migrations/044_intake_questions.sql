-- =============================================================================
-- Migration 044 — Pre-call intake questions
-- =============================================================================
-- Lets each team-calendar owner define 0-N qualifying questions that bookers
-- answer right on the /c/<handle> page before they hit Confirm. Answers land
-- in bookings.booker_answers, are included in the confirmation email, and
-- show up in the leads.html drawer.
--
-- Question shape:
--   [
--     { "id": "q_company_size",
--       "label": "Company size?",
--       "type": "text" | "textarea" | "email" | "tel",
--       "required": false,
--       "placeholder": "e.g. 5 employees" }
--   ]
--
-- Answer shape:
--   { "q_company_size": "12", "q_challenge": "Onboarding new staff is slow" }
-- =============================================================================

alter table public.team_calendars
    add column if not exists intake_questions jsonb not null default '[]'::jsonb;

alter table public.bookings
    add column if not exists booker_answers jsonb not null default '{}'::jsonb;


select 'migration 044 applied' as status,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='team_calendars' and column_name='intake_questions'
       ) as tc_column,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='bookings' and column_name='booker_answers'
       ) as bk_column;
