# LYMX Power — Playbook Index

> Registry of every process playbook for LYMX Power. Format spec lives at `shared accross projects\PLAYBOOK-CREATION-RULES.md`.
>
> Each row carries a `Feature` key that ties the playbook to an entry in `public.feature_catalog` (mig 104). The Playbooks reader filters by `list_my_permissions()` — a member with permission for a feature sees that feature's playbook automatically. Toggle grants live at `/admin-manage-permissions.html`.
>
> Last updated: 2026-05-27 (Sprint 6 — Partner network surfaces)

## Email

| Slug | Title | Role | Feature | Status |
|---|---|---|---|---|
| [partner-email-setup](partner-email-setup.md) | Connect your @getlymx.com email to Gmail | Partner | partner_configure_email | ✅ Verified 2026-05-24 |

## Earn / Compensation

| Slug | Title | Role | Feature | Status |
|---|---|---|---|---|
| [comp-plan-partner-walkthrough](comp-plan-partner-walkthrough.md) | Understand the LYMX Partner Comp Plan | Partner | partner_view_comp_plan | ✅ Verified 2026-05-26 |

## Customer onboarding

| Slug | Title | Role | Feature | Status |
|---|---|---|---|---|
| [customer-onboarding-03-pending-reviews](customer-onboarding/03-pending-reviews.md) | See and write your pending reviews (earn 100 LYMX each) | Customer | customer_write_review | ✅ Verified 2026-05-26 |
| [customer-onboarding-04-donate-lymx](customer-onboarding/04-donate-lymx.md) | Donate LYMX from your wallet to a verified nonprofit (Sprint 2) | Customer | customer_donate_lymx | 🚧 Shipped 2026-05-27; awaiting browser-verify |
| [customer-onboarding-05-browse-all](customer-onboarding/05-browse-all.md) | Find any business on the LYMX network (Sprint 5 — full directory + search + pagination) | Customer |  | 🚧 Shipped 2026-05-27; awaiting browser-verify |

## Onboarding

| Slug | Title | Role | Feature | Status |
|---|---|---|---|---|
| customer-onboarding | Sign up, get 100 LYMX, find your first business | Customer |  | 📋 Planned |
| [business-onboarding-readme](business-onboarding/README.md) | Business onboarding flow — overview + step index | Multiple |  | 🚧 In progress |
| [business-onboarding-01-invite](business-onboarding/01-invite.md) | Invite a business to LYMX | Admin / Partner | invite_business | ✅ Verified 2026-05-26 |
| [business-onboarding-02-signup](business-onboarding/02-signup.md) | Sign up your business on LYMX (from invite) | Prospect (guest) | business_signup_self | ✅ Verified 2026-05-26 |
| [business-onboarding-03-approval](business-onboarding/03-approval.md) | Review a pending business application (approve / request more info / reject) | Admin | approve_business_application | ✅ Verified 2026-05-26 |
| [business-onboarding-04-approval-email-and-callback](business-onboarding/04-approval-email-and-callback.md) | Approval email + the required 20-min onboarding call + nudge cron | Admin | send_business_approval_email | ✅ Verified 2026-05-26 |
| [business-onboarding-05-booking-the-call](business-onboarding/05-booking-the-call.md) | Book + run the 20-min onboarding call (Daily.co room + post-call summary) | Business prospect / Admin | book_onboarding_call | ✅ Verified 2026-05-26 |
| [business-onboarding-06-issuing-lymx](business-onboarding/06-issuing-lymx.md) | Issue and redeem LYMX at your business (Module 5 unified pipeline) | Business owner / Engineer | issue_lymx_at_business | ✅ Verified 2026-05-26 |
| [business-onboarding-07-customer-redeems](business-onboarding/07-customer-redeems.md) | How a customer sees, earns, and redeems LYMX (Module 6 customer surfaces) | Customer / Engineer | redeem_lymx_at_business | ✅ Verified 2026-05-26 |
| [business-onboarding-08-settlement](business-onboarding/08-settlement.md) | How your monthly LYMX settlement works (Sprint 1 — clearing-house model) | Business | business_view_settlements | 🚧 Shipped 2026-05-27; awaiting browser-verify |
| [business-onboarding-09-print-kit](business-onboarding/09-print-kit.md) | Download your customized print kit (window clings, table tents, QR cards in en/es/zh-CN) | Business | business_download_print_kit | 🚧 Shipped 2026-05-27; awaiting browser-verify |
| partner-onboarding | Apply, get $750 setup, pitch your first business | Partner |  | 📋 Planned |
| [partner-notifications](partner-onboarding/notifications.md) | Your partner notifications feed (Sprint 3 — auto-emit on commission/activation/settlement) | Partner | partner_view_notifications | 🚧 Shipped 2026-05-27; awaiting browser-verify |
| [partner-my-network](partner-onboarding/my-network.md) | Recruited customers + recruited business reviews (Sprint 6) | Partner |  | 🚧 Shipped 2026-05-27; awaiting browser-verify |

## Business operations

| Slug | Title | Role | Feature | Status |
|---|---|---|---|---|
| [business-operations-reservations](business-operations/reservations.md) | Manage table reservations (Sprint 4 — biz-reservations.html inbox) | Business | manage_reservations | 🚧 Shipped 2026-05-27; awaiting browser-verify |

## Daily operations (planned)

| Slug | Title | Role | Feature | Status |
|---|---|---|---|---|
| customer-first-purchase | Earn LYMX at a business for the first time | Customer |  | 📋 Planned |
| business-create-promo | Run a happy hour or seasonal promo | Business |  | 📋 Planned |
| partner-pitch-toolkit | Open the toolkit + print pitch materials | Partner |  | 📋 Planned |
| partner-book-rachel | Schedule a 1-on-1 with Rachel (concierge) | Partner |  | 📋 Planned |
| partner-share-link | Share your referral link (3 separate role links) | Partner |  | 📋 Planned |
| customer-saved-businesses | Save a business + view your saved list | Customer |  | 📋 Planned |
| customer-write-review | Earn 100 LYMX for a transaction-verified review | Customer |  | 📋 Planned |

## HR / Staff onboarding

| Slug | Title | Role | Feature | Status |
|---|---|---|---|---|
| [hr-onboarding-end-to-end](hr-onboarding-end-to-end.md) | Onboard a new staff member end-to-end (offer → first day) | Admin / HR | manage_hr_onboarding | ✅ Verified 2026-05-25 |

## Admin

| Slug | Title | Role | Feature | Status |
|---|---|---|---|---|
| admin-manage-permissions | Toggle feature permissions per member (matrix UI) | Admin | admin_manage_permissions | 🚧 In progress (page shipped 2026-05-26; playbook pending) |
| [admin-settlement-run](admin/settlement-run.md) | Run a monthly business settlement batch (Sprint 1) | Admin | admin_run_settlements | 🚧 Shipped 2026-05-27; awaiting browser-verify |
| [admin-clock-in-now](admin/clock-in-now.md) | Live view of who is currently clocked in / on break / out | Admin | admin_view_clock_in_now | 🚧 Shipped 2026-05-27; awaiting browser-verify |
| [admin-timesheet-edit](admin/timesheet-edit.md) | Backfill or adjust a staff member's daily timesheet line | Admin / HR / CFO / Accounting | admin_edit_timesheet | 🚧 Shipped 2026-05-27; awaiting browser-verify |
| admin-handle-feedback | Triage + reply to a feedback ticket | Admin |  | 📋 Planned |
| admin-broadcast | Send a team-wide announcement | Admin |  | 📋 Planned |

## Status legend

- ✅ Verified — file exists, format-checked, walked end-to-end recently
- 🚧 Draft — file exists, may have gaps or stale steps
- 📋 Planned — file doesn't exist yet
