-- =============================================================================
-- Migration 010 — Partner invite tracking
-- =============================================================================
-- Adds public.partner_invites: a log of every invitation a Partner sends.
-- Lets Kenny (or any Partner) avoid double-messaging the same person, and
-- shows which invites converted into actual signups.
--
-- Powered by admin-invite-friends.html. Compatible with broadcast-send
-- Edge Function — that's how the actual emails go out.
-- =============================================================================

create table if not exists public.partner_invites (
    id              uuid primary key default uuid_generate_v4(),

    -- Who sent it
    sender_id       uuid not null references auth.users(id) on delete cascade,

    -- Who they sent it to
    invitee_email   text not null check (invitee_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    invitee_name    text,

    -- What template was used
    template        text not null check (template in ('partner','customer','business')),
    message_subject text,

    -- Status of the invite
    status          text not null default 'sent' check (status in ('queued','sent','signed_up','bounced','unsubscribed','failed')),
    error           text,

    -- If they signed up
    signup_user_id  uuid references auth.users(id) on delete set null,
    signed_up_at    timestamptz,

    sent_at         timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    -- Don't double-invite the same person with the same template from the same sender
    unique (sender_id, invitee_email, template)
);

create index if not exists idx_partner_invites_sender   on public.partner_invites(sender_id, sent_at desc);
create index if not exists idx_partner_invites_email    on public.partner_invites(invitee_email);
create index if not exists idx_partner_invites_status   on public.partner_invites(status);

-- updated_at trigger
create or replace function public.set_partner_invites_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists partner_invites_updated_at on public.partner_invites;
create trigger partner_invites_updated_at
    before update on public.partner_invites
    for each row execute function public.set_partner_invites_updated_at();

-- ---- RLS ------------------------------------------------------------------
alter table public.partner_invites enable row level security;

-- Sender can read + write their own invites
drop policy if exists invites_select_own on public.partner_invites;
create policy invites_select_own on public.partner_invites
    for select to authenticated
    using (sender_id = auth.uid());

drop policy if exists invites_insert_own on public.partner_invites;
create policy invites_insert_own on public.partner_invites
    for insert to authenticated
    with check (sender_id = auth.uid());

drop policy if exists invites_update_own on public.partner_invites;
create policy invites_update_own on public.partner_invites
    for update to authenticated
    using (sender_id = auth.uid())
    with check (sender_id = auth.uid());

-- Admin (staff_roles.role='admin') can read + write everyone's invites.
-- 2026-05-26: replaced Kenny-UUID literal with public.am_i_admin().
drop policy if exists invites_admin_all on public.partner_invites;
create policy invites_admin_all on public.partner_invites
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());


-- ---- Helper: handler when a new auth user signs up via an invite link -----
-- (Optional v1 — can wire later via auth.users insert trigger)


-- ---- Grants ---------------------------------------------------------------
grant select, insert, update on public.partner_invites to authenticated;

-- =============================================================================
-- End of migration 010
-- =============================================================================
