-- =============================================================================
-- Migration 057 — HR Phase B: policy documents + e-sign assignments
-- 2026-05-19
-- =============================================================================
--
-- Mirror of InvestPro PM db/201 (the policy-doc + assignment bits).
-- Master policy template table + per-staff assignment table.  Two sign
-- methods: click-acknowledge (most policies) and e-sign (NDA, IC agreement).
--
-- Seeds 6 NV-compliant policies adapted for LYMX Power:
--   1. Office Policy & Code of Conduct
--   2. Anti-Harassment / EEO
--   3. NDA / Confidentiality
--   4. Remote Work Agreement
--   5. Independent Contractor Agreement (1099 only)
--   6. Employee Handbook Receipt
--
-- Depends on migration 055 (am_i_hr_or_admin, staff_profiles).
-- =============================================================================


-- ---------- 1. policy_documents — master template table -------------------
create table if not exists public.policy_documents (
    id                  uuid primary key default gen_random_uuid(),
    code                text not null unique,                       -- stable slug, used in seeds + UI lookups
    title               text not null,
    version             int  not null default 1,
    sign_method         text not null check (sign_method in ('click_acknowledge','e_sign')),
    body_md             text not null,                              -- markdown body, rendered in UI + saved to PDF on sign
    requires_witness    boolean not null default false,
    remote_only         boolean not null default false,             -- only assign to remote staff
    role_specific       text,                                       -- if set, only assign to staff with this title/role
    active              boolean not null default true,
    superseded_by       uuid references public.policy_documents(id) on delete set null,
    effective_from      date not null default current_date,
    created_at          timestamptz not null default now(),
    created_by          uuid references auth.users(id) on delete set null,
    updated_at          timestamptz not null default now()
);

create index if not exists idx_policy_docs_active on public.policy_documents(active) where active;


-- ---------- 2. policy_assignments — one row per (policy × staff) ----------
create table if not exists public.policy_assignments (
    id                  uuid primary key default gen_random_uuid(),
    policy_id           uuid not null references public.policy_documents(id) on delete restrict,
    profile_id          uuid not null references auth.users(id) on delete cascade,

    -- Snapshot at assignment time so audit trail survives template edits
    policy_title        text not null,
    policy_version      int  not null,
    policy_sign_method  text not null,

    -- Lifecycle
    status              text not null default 'assigned'
                            check (status in ('assigned','sent','acknowledged','signed','expired','revoked')),
    assigned_at         timestamptz not null default now(),
    assigned_by_id      uuid references auth.users(id) on delete set null,
    sent_at             timestamptz,
    acknowledged_at     timestamptz,                                -- click-acknowledge path
    signed_at           timestamptz,                                -- e-sign path
    signature_image     text,                                       -- e-sign image data URL
    signature_ip        inet,
    signature_geo       text,
    saved_pdf_url       text,                                       -- personnel-files/<uuid>/policy_<id>_<ts>.pdf

    -- Reminder cadence
    last_reminded_at    timestamptz,
    reminder_count      int not null default 0,

    -- Audit notes
    notes               text,
    revoked_reason      text,

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),

    constraint policy_assignments_unique unique (policy_id, profile_id)
);

create index if not exists idx_pa_profile  on public.policy_assignments(profile_id, status);
create index if not exists idx_pa_pending  on public.policy_assignments(status) where status in ('assigned','sent');


-- ---------- 3. updated_at triggers ----------------------------------------
create or replace function public.tg_policy_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end$$;

drop trigger if exists trg_policy_documents_updated_at on public.policy_documents;
create trigger trg_policy_documents_updated_at
    before update on public.policy_documents
    for each row execute function public.tg_policy_updated_at();

drop trigger if exists trg_policy_assignments_updated_at on public.policy_assignments;
create trigger trg_policy_assignments_updated_at
    before update on public.policy_assignments
    for each row execute function public.tg_policy_updated_at();


-- ---------- 4. acknowledge_policy_assignment RPC --------------------------
-- Staff calls this to click-acknowledge a click-method policy.
-- Stamps IP + timestamp + flips status to 'acknowledged'.
create or replace function public.acknowledge_policy_assignment(
    p_assignment_id uuid
)
returns public.policy_assignments
language plpgsql security definer
as $$
declare
    v_row public.policy_assignments;
    v_ip  inet;
begin
    -- Get the client IP from the request headers if available
    begin
        v_ip := current_setting('request.headers', true)::jsonb->>'x-forwarded-for';
    exception when others then
        v_ip := null;
    end;

    select * into v_row from public.policy_assignments
     where id = p_assignment_id;

    if v_row.id is null then
        raise exception 'Policy assignment not found';
    end if;

    if v_row.profile_id <> auth.uid() then
        raise exception 'Only the assigned staff can acknowledge';
    end if;

    if v_row.policy_sign_method <> 'click_acknowledge' then
        raise exception 'This policy requires e-sign, not click-acknowledge';
    end if;

    if v_row.status not in ('assigned','sent') then
        raise exception 'Policy already actioned (status=%)', v_row.status;
    end if;

    update public.policy_assignments
       set status          = 'acknowledged',
           acknowledged_at = now(),
           signature_ip    = v_ip
     where id = p_assignment_id
    returning * into v_row;

    return v_row;
end$$;


-- ---------- 5. bulk_assign_policies helper --------------------------------
-- Admin/HR helper: given a list of policy_ids and a list of profile_ids,
-- creates assignments for every cross-pair, skipping duplicates.  Returns
-- counts.
create or replace function public.bulk_assign_policies(
    p_policy_ids   uuid[],
    p_profile_ids  uuid[]
)
returns table (created_count int, skipped_count int)
language plpgsql security definer
as $$
declare
    v_created int := 0;
    v_skipped int := 0;
    v_policy  record;
    v_pid     uuid;
begin
    if not public.am_i_hr_or_admin() then
        raise exception 'Only HR / admin can bulk-assign policies';
    end if;

    foreach v_pid in array p_profile_ids loop
        for v_policy in
            select * from public.policy_documents
             where id = any(p_policy_ids) and active = true
        loop
            begin
                insert into public.policy_assignments (
                    policy_id, profile_id,
                    policy_title, policy_version, policy_sign_method,
                    assigned_by_id
                ) values (
                    v_policy.id, v_pid,
                    v_policy.title, v_policy.version, v_policy.sign_method,
                    auth.uid()
                );
                v_created := v_created + 1;
            exception when unique_violation then
                v_skipped := v_skipped + 1;
            end;
        end loop;
    end loop;

    return query select v_created, v_skipped;
end$$;


-- ---------- 6. Seed 6 NV-LYMX policies ------------------------------------
insert into public.policy_documents (code, title, version, sign_method, body_md, remote_only, role_specific)
values
    ('lymx_office_conduct', 'Office Policy & Code of Conduct (LYMX Power)', 1, 'click_acknowledge',
'# LYMX Power — Office Policy & Code of Conduct

**Effective:** 2026-05-19   |   **Location:** Las Vegas, NV

LYMX Power maintains a workplace built on mutual respect, integrity, and customer focus. This policy sets the baseline expectations for everyone, regardless of role.

## 1. Professional conduct
- Treat coworkers, partners, businesses, and customers with respect at all times.
- Speak honestly. If you don''t know, say "I don''t know" — never invent.
- No drugs, alcohol, or impaired operation during work hours.
- Dress is business-casual in office; remote workers maintain a presentable backdrop on video calls.

## 2. Confidentiality
- Customer data, transaction records, partner commissions, and unreleased product plans are confidential.
- See the LYMX NDA for legal-grade terms; this section is the everyday version.
- Never post screenshots of customer records, internal dashboards, or fraud flags on social media or external chats.

## 3. Equipment + accounts
- Use your @lymxpower.com email for all work. Personal email is not appropriate for company business.
- Return all company equipment on termination (laptops, access cards, phones, lockbox combos).
- Don''t install unapproved software on company devices.

## 4. Communication
- Reply to internal messages within one business day.
- If you''re going to miss a deadline, say so before it''s due.
- Bug reports, partner asks, and customer issues should be tracked in the appropriate system, not buried in DMs.

## 5. Anti-fraud
- Never issue LYMX rewards to yourself or family members without documented authorization.
- Report any suspected fraud — by a customer, business, partner, or staff member — to HR immediately.

## 6. At-will employment
This policy does not modify Nevada''s at-will employment doctrine. Either you or LYMX Power may end the employment relationship at any time, with or without cause, and with or without notice.

By acknowledging this policy you confirm you have read it, understand it, and will comply with it.', false, null),

    ('lymx_anti_harassment', 'Anti-Harassment / EEO Policy (LYMX Power)', 1, 'click_acknowledge',
'# LYMX Power — Anti-Harassment & Equal Employment Opportunity

**Effective:** 2026-05-19   |   **State:** Nevada

## 1. Equal opportunity
LYMX Power is an Equal Opportunity Employer. We do not discriminate on the basis of race, color, religion, sex, sexual orientation, gender identity or expression, national origin, age, disability, genetic information, marital status, pregnancy, veteran status, or any other characteristic protected by federal, Nevada (NRS 613), or local law.

## 2. Harassment is not tolerated
Harassment of any kind — sexual or otherwise — is strictly prohibited. This includes:
- Unwelcome conduct based on a protected characteristic
- Conduct that creates a hostile, intimidating, or offensive work environment
- Quid pro quo demands

This applies in the office, at off-site events, during business travel, on company chat platforms, and on any company-affiliated social media.

## 3. How to report
You can report harassment to:
- Your direct supervisor
- HR (hr@lymxpower.com or Helen directly)
- The Founder (kenny@lymxpower.com)
- The Nevada Equal Rights Commission (anonymous external option)

Retaliation against anyone who reports in good faith is itself a violation of this policy and grounds for termination.

## 4. Investigation
Every report is taken seriously and investigated promptly and discreetly. We will inform the reporter of the outcome to the extent legally and operationally possible.

By acknowledging this policy you confirm you have read it, understand it, and commit to a harassment-free workplace.', false, null),

    ('lymx_nda', 'Non-Disclosure Agreement (LYMX Power)', 1, 'e_sign',
'# Non-Disclosure Agreement — LYMX Power

**Parties:** LYMX Power, a Nevada entity ("Company"), and the undersigned employee or contractor ("Recipient").
**Effective:** Date of signature below.

## 1. Confidential Information includes (without limitation):
- Customer personal information, transaction history, wallet balances, and LYMX issuance records
- Business partner financial data, commission structures, payout amounts
- Partner program economics, recruiting strategy, downline trees
- Source code, schemas, internal tools, fraud-detection rules, security measures
- Roadmap, unreleased features, business plans, financial projections
- Any other non-public information marked or reasonably understood as confidential

## 2. Recipient agrees to:
- Hold all Confidential Information in strict confidence
- Use it solely to perform their role for the Company
- Not disclose it to anyone outside the Company without written authorization
- Return or destroy all copies upon termination or upon Company request
- Maintain these obligations indefinitely for trade secrets and for three (3) years for other Confidential Information after the engagement ends

## 3. Exceptions
This NDA does not apply to information that is or becomes publicly known through no fault of Recipient, was already lawfully known to Recipient, or is required to be disclosed by law (in which case Recipient will give Company prompt notice).

## 4. Remedies
A breach causes irreparable harm. The Company is entitled to seek injunctive relief in addition to damages and reasonable attorneys'' fees.

## 5. At-will + governing law
This NDA does not create an employment contract. Nevada law governs. Venue is Clark County, Nevada.

By e-signing, I acknowledge I have read this Agreement, understand it, and accept its terms.', false, null),

    ('lymx_remote_work', 'Remote Work Agreement (LYMX Power)', 1, 'e_sign',
'# Remote Work Agreement — LYMX Power

For staff whose role is approved for remote or hybrid work.

## 1. Work hours
Your scheduled hours are as agreed with your manager. You are expected to be available, online, and responsive during those hours.

## 2. Workspace
- A dedicated, distraction-free workspace with reliable high-speed internet
- A quiet environment for video calls; appropriate lighting + presentable backdrop
- Lock your screen when stepping away from confidential data

## 3. Equipment
- Company-issued laptop must be used for all work
- Personal devices may not access customer data or internal admin tools without explicit HR approval
- Lost or damaged equipment must be reported to HR within 24 hours

## 4. Security
- Use the VPN where required
- Never let family members or roommates use your work device
- All data stays on company systems — no copying to personal cloud accounts

## 5. Performance + reporting
- You are expected to deliver the same quality and timeliness as on-site staff
- Time clock + shift acceptance still apply (clock_in_exempt staff excluded)
- Your manager may schedule regular video check-ins

## 6. End of remote arrangement
Remote work is a privilege, not a guarantee. The Company may revoke or modify your remote work approval at any time based on business needs or performance.

By e-signing, I commit to these terms and the security expectations above.', true, null),

    ('lymx_ic_agreement', 'Independent Contractor Agreement (LYMX Power)', 1, 'e_sign',
'# Independent Contractor Agreement — LYMX Power

For 1099 contractors only.

## 1. Status
You are an independent contractor — not an employee. You are responsible for your own taxes (1099-NEC will be issued for $600+ paid in a year), insurance, and benefits.

## 2. Scope
Specific deliverables, timeline, and payment terms are agreed in a separate Statement of Work (SOW). This Agreement covers the relationship; the SOW covers the work.

## 3. Confidentiality
You are bound by the LYMX NDA in addition to this Agreement.

## 4. Intellectual Property
All work product created for LYMX Power — code, designs, content, documents — is the exclusive property of LYMX Power upon payment. You assign all rights now and in the future for such work product.

## 5. Termination
Either party may terminate this Agreement with seven (7) days written notice. Either party may terminate immediately for material breach.

## 6. Independent status
- No company benefits (PTO, health, retirement)
- You set your own hours and work location, subject to deliverable deadlines
- You may have other clients, provided no conflict of interest and no use of LYMX confidential information

## 7. Governing law
Nevada. Clark County venue.

By e-signing, I confirm I am an independent contractor under this Agreement.', false, '1099_contractor'),

    ('lymx_handbook_receipt', 'Employee Handbook Receipt (LYMX Power)', 1, 'click_acknowledge',
'# Employee Handbook Receipt — LYMX Power

I acknowledge that I have received a copy of the LYMX Power Employee Handbook (v1, May 2026) and that I am responsible for reading, understanding, and complying with its policies.

I understand that:
- The Handbook is a guide, not an employment contract
- LYMX Power may modify its policies at any time at its sole discretion, with reasonable notice
- The Handbook supplements but does not replace any signed agreements (NDA, IC Agreement, Remote Work Agreement)
- Nevada at-will employment applies
- Final pay timing follows Nevada NRS 608.020 / 608.030 (no-fault and voluntary timing)

If anything in the Handbook is unclear, I will ask HR for clarification rather than assume.', false, null)
on conflict (code) do nothing;


-- ---------- 7. RLS --------------------------------------------------------
alter table public.policy_documents   enable row level security;
alter table public.policy_assignments enable row level security;

-- policy_documents: everyone authenticated can read active versions; HR/admin can edit
drop policy if exists pdocs_read_active on public.policy_documents;
create policy pdocs_read_active on public.policy_documents for select to authenticated
    using (active = true OR public.am_i_hr_or_admin());

drop policy if exists pdocs_hr_write on public.policy_documents;
create policy pdocs_hr_write on public.policy_documents for all to authenticated
    using (public.am_i_hr_or_admin())
    with check (public.am_i_hr_or_admin());

-- policy_assignments: staff sees own; HR/admin sees + writes all
drop policy if exists pa_self_read on public.policy_assignments;
create policy pa_self_read on public.policy_assignments for select to authenticated
    using (profile_id = auth.uid());

drop policy if exists pa_self_update on public.policy_assignments;
create policy pa_self_update on public.policy_assignments for update to authenticated
    using (profile_id = auth.uid())
    with check (profile_id = auth.uid()
                and status in ('acknowledged','signed'));

drop policy if exists pa_hr_all on public.policy_assignments;
create policy pa_hr_all on public.policy_assignments for all to authenticated
    using (public.am_i_hr_or_admin())
    with check (public.am_i_hr_or_admin());


-- ---------- 8. Grants -----------------------------------------------------
grant select on public.policy_documents to authenticated;
grant select, update on public.policy_assignments to authenticated;
grant execute on function public.acknowledge_policy_assignment(uuid) to authenticated;
grant execute on function public.bulk_assign_policies(uuid[], uuid[]) to authenticated;
grant all on public.policy_documents   to service_role;
grant all on public.policy_assignments to service_role;


-- ---------- 9. Sanity ----------------------------------------------------
do $$ begin
    if not exists (select 1 from pg_proc where proname='am_i_hr_or_admin' and pg_function_is_visible(oid)) then
        raise exception 'am_i_hr_or_admin missing — apply migration 055 first';
    end if;
end$$;
