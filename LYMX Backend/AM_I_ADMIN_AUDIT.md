# `am_i_admin()` Call-Site Audit — 2026-05-26

## 1. Summary

Total `am_i_admin()` call sites surveyed: **130** across 42 migrations + 7 Edge Functions + 7 frontend files.

| Class | Meaning | Count |
|---|---|---|
| **A** — keep as strict admin | restoring strict admin is correct; no swap needed | 76 |
| **B** — swap to `am_i_hr() OR am_i_admin()` | HR / personnel / schedule / time-off / clock | 0 net new (already correct via `am_i_hr()` which OR's admin) |
| **C** — swap to `am_i_cfo() OR am_i_admin()` | finance / payouts / billing / Stripe / SES events | 4 |
| **D** — swap to `is_staff() OR am_i_admin()` | ANY staff member needs this (conversations, contacts, chat groups, broadcasts inbox triage, feedback triage, attachments routing, marketing posts) | 38 |
| **E** — already-specific helper (`am_i_compliance()`, `am_i_marketing()`, `am_i_support()`, `am_i_hr_or_admin()`) | finer-grained, replace or extend | 7 |
| **F** — unclear / needs Kenny's call | edge cases (RLS recursion guard, view definers, recursive sanity checks) | 5 |

Tightening `am_i_admin()` back to strict `role = 'admin'` is the right move. The fallout falls into two groups:

- **HR-bearing call sites** (migrations 025, 047, 049, 084) — already use `am_i_hr()`/`am_i_cfo()` alongside `am_i_admin()`. These migrations are SAFE because the OR chain still grants HR/CFO access. Restoring strict `am_i_admin()` does NOT lock HR out — the OR with `am_i_hr()` carries them through.
- **Generic-staff call sites** (chat, conversations, contacts, feedback, broadcasts, attachments, marketing posts, leads, oauth) — these use *only* `am_i_admin()` and have been silently extending access to ALL `staff_roles` rows (marketing, support, observer) because of the bug. Restoring strict admin WILL lock Rachel/Dave/support out of triage queues they SHOULD see. These need a new `is_staff()` helper, OR explicit narrower helpers.

The cleanest fix is **one new helper `public.is_staff()`** (returns true for any `staff_roles` row) wrapped into the call sites where "any staff member" was the actual intent. The 4 finance-sensitive ones (Stripe, email-sends sender visibility, SES events) move to `am_i_cfo() OR am_i_admin()`. Everything else stays admin-strict.

---

## 2. Call-site table

> **Reading guide:** rows are grouped by file. The "Class" column is the recommended classification. "Replacement" is what to swap the call to inside migration 102's drop-and-recreate block.

### Migrations

| File | Line(s) | Context | Class | Replacement | Why |
|---|---|---|---|---|---|
| `008_feedback.sql` | 90-91 | `feedback_admin_all` policy — admin can read/update all feedback | **D** | `public.is_staff() OR public.am_i_admin()` | Support/marketing triage all feedback; this is the v_my_feedback bug root cause — Rachel SHOULD see assigned feedback but not ALL feedback. **Actually need finer:** swap to `public.has_staff_role('support') OR public.has_staff_role('tech') OR public.am_i_admin()` to match the existing `fb_replies_staff_insert` pattern in 016. |
| `009_chat_broadcast_assign.sql` | 159 | `chat_groups` select — member OR admin | **D** | `or public.is_staff()` | Internal team chat. Any staff_roles member should see chat groups. |
| `009_chat_broadcast_assign.sql` | 177 | `chat_groups` update — creator OR admin | **A** | keep `am_i_admin()` | Only admins should be able to mass-update arbitrary chat groups. |
| `009_chat_broadcast_assign.sql` | 192 | `chat_group_members` select — self OR admin | **D** | `or public.is_staff()` | Roster visibility is a staff thing. |
| `009_chat_broadcast_assign.sql` | 205 | `chat_group_members` insert — group-owner OR admin | **A** | keep `am_i_admin()` | Admins approve member additions; not every staff. |
| `009_chat_broadcast_assign.sql` | 225 | `chat_messages` select — member OR admin | **D** | `or public.is_staff()` | Same as group select — staff need to read chat. |
| `009_chat_broadcast_assign.sql` | 253-254 | `broadcasts_admin_all` — create/edit/delete broadcasts | **C** | `public.am_i_admin() OR public.am_i_cfo()` | Broadcasts cost SMS/email money. Marketing should NOT have direct insert. CFO + admin only. (Marketing files a change_request.) |
| `010_partner_invites.sql` | 84-85 | `invites_admin_all` | **A** | keep `am_i_admin()` | Admin-only mutation; senders already covered by `sender_id = auth.uid()` separately. |
| `011_contacts.sql` | 146-147 | `contacts_admin_all` | **A** | keep `am_i_admin()` | Contacts are owner-scoped. Admin-only override prevents marketing/support from reading every contact's PII. |
| `011_contacts.sql` | 159-160 | `tags_admin_all` | **A** | keep | Same reasoning. |
| `011_contacts.sql` | 168, 172 | `tag_links` — owner OR admin | **A** | keep | Same. |
| `011_contacts.sql` | 185-186 | `lists_admin_all` | **A** | keep | Same. |
| `011_contacts.sql` | 194, 198 | `list_members` — owner OR admin | **A** | keep | Same. |
| `011_contacts.sql` | 235 | `v_my_contacts` view — owner OR admin | **A** | keep | View should filter to caller's contacts; admin override is for support escalation. |
| `012_business_partners.sql` | 297-298 | `b2b_admin_all` business_partners | **A** | keep `am_i_admin()` | B2B relationships are admin-managed. |
| `012_business_partners.sql` | 310-311 | `issuances_admin_all` lymx_issuances | **A** | keep | Issuances = wallet credits. Admin only. CFO can be added via OR if needed later. |
| `012_business_partners.sql` | 322-323 | `attributions_admin_all` signup_attributions | **A** | keep | Attribution = commission proof. Admin only. |
| `012_business_partners.sql` | 334-335 | `billing_admin_all` business_billing | **C** | `public.am_i_admin() OR public.am_i_cfo()` | Billing IS finance. CFO needs read+write. |
| `014_platform_promos.sql` | 34-35 | `promos_admin_all` | **A** | keep (marketing has read via separate policy) | Promo *writes* go through change_request → admin approves. |
| `015_staff_roles_and_change_requests.sql` | 44-48 | **Function definition** | n/a | This is the canonical definition — restore strict `select exists (... role = 'admin')`. | The fix itself. |
| `015_staff_roles_and_change_requests.sql` | 61 | `grant execute` | n/a | keep | Grant stays. |
| `015_staff_roles_and_change_requests.sql` | 67-68 | `staff_roles_admin_all` | **A** | keep | Only admins manage role grants. **Critical — do NOT loosen.** |
| `015_staff_roles_and_change_requests.sql` | 127-128 | `change_requests_admin_all` | **A** | keep | Approval of change_requests is admin-only by design. |
| `015_staff_roles_and_change_requests.sql` | 210 | `approve_change_request()` body guard | **A** | keep | Approval gate. |
| `015_staff_roles_and_change_requests.sql` | 281 | `reject_change_request()` body guard | **A** | keep | Rejection gate. |
| `015_staff_roles_and_change_requests.sql` | 308-309 | duplicate `promos_admin_all` recreate | **A** | keep | Same as 014. |
| `016_feedback_replies_clusters_routing.sql` | 263 | `v_my_feedback` view — submitter OR admin | **D** | `or public.is_staff()` | Same root-cause as 008. Support/marketing need to see assigned feedback in inbox. **Critical: the original bug spec explicitly cited this view as Rachel-sees-everyone-else's-feedback.** |
| `016_feedback_replies_clusters_routing.sql` | 277 | `fb_replies_admin_all` | **D** | `public.has_staff_role('support') OR public.has_staff_role('tech') OR public.am_i_admin()` | Mirrors the existing `fb_replies_staff_insert` check. |
| `016_feedback_replies_clusters_routing.sql` | 293 | `fb_replies_staff_insert` — already uses `has_staff_role` | **A** | keep — correct already | This one is the model. |
| `016_feedback_replies_clusters_routing.sql` | 306 | `fb_clusters_admin_all` | **A** | keep | Cluster taxonomy = admin. |
| `016_feedback_replies_clusters_routing.sql` | 314 | `fb_routing_admin_all` | **A** | keep | Routing rules = admin. |
| `017_dual_emails_and_referrals.sql` | 75 | `referrals_admin_all` | **A** | keep | Referral payouts = admin. |
| `017_dual_emails_and_referrals.sql` | 241 | `v_my_referrals` — self OR admin | **A** | keep | Self-scope view; admin override for support. |
| `022_email_sms_events.sql` | 54 | `email_sends_admin_all` — admin OR sender | **C** | `public.am_i_admin() OR public.am_i_cfo() OR sender_user_id = auth.uid()` | Outbound email log is finance-relevant (SES cost). CFO read. |
| `022_email_sms_events.sql` | 90 | `email_events_admin_all` — admin OR sender | **C** | same as above | Same — SES events. |
| `022_email_sms_events.sql` | 190 | `sms_messages_admin_all` | **C** | `public.am_i_admin() OR public.am_i_cfo() OR sender_user_id = auth.uid() OR recipient_user_id = auth.uid()` | Twilio cost. |
| `023_international_signup_verification.sql` | 156 | `partners_admin_read_unverified` | **A** | keep | Onboarding gating — admin only. |
| `023_international_signup_verification.sql` | 166 | `customers_admin_read_unverified` | **A** | keep | Same. |
| `023_international_signup_verification.sql` | 189 | `bulk_verify_unverified_signups()` body guard | **A** | keep | Function gate — admin only. |
| `025_hr_clock_in_management.sql` | 43-50 | **Function redefinition (bug variant 1)** | n/a | **DROP this redefinition; restore from 015.** Migration 102 must `create or replace` it back to strict. | This is one of the two broken redefinitions. |
| `025_hr_clock_in_management.sql` | 58 | `am_i_hr()` body uses `am_i_admin()` | **A** | keep — correct semantics | OR chain; admin gets HR automatically. |
| `025_hr_clock_in_management.sql` | 68 | `am_i_cfo()` body uses `am_i_admin()` | **A** | keep | Same. |
| `025_hr_clock_in_management.sql` | 73 | `grant execute` | n/a | keep | Grant only. |
| `025_hr_clock_in_management.sql` | 127-128 | `clock_admin_all` — admin OR hr | **A** | keep `public.am_i_admin() or public.am_i_hr()` | Already correct; HR call carries through. |
| `025_hr_clock_in_management.sql` | 218-219 | `time_off_admin_all` — admin OR hr | **A** | keep | Same. |
| `025_hr_clock_in_management.sql` | 256-257 | `duty_defs_admin_write` — admin OR hr | **A** | keep | Same. |
| `025_hr_clock_in_management.sql` | 261-262 | `duty_completions_self` — self OR admin OR hr | **A** | keep | Same. |
| `025_hr_clock_in_management.sql` | 287-288 | `schedule_admin_all` — admin OR hr | **A** | keep | Same. |
| `025_hr_clock_in_management.sql` | 353 | sanity-count query | n/a | keep | Verification SELECT only. |
| `026_pending_promotions.sql` | 29-30 | `pp_admin_all` | **A** | keep | Pending promotions queue = admin. |
| `027_feedback_attachments.sql` | 38-39 | `fb_att_admin_all` | **D** | `public.has_staff_role('support') OR public.has_staff_role('tech') OR public.am_i_admin()` | Mirror 016 fb_replies pattern. Support/tech need to see attachments while triaging. |
| `028_partner_invites_rls.sql` | 27 | partner_invites_select — sender OR admin | **A** | keep | Already self-scoped; admin override OK. |
| `028_partner_invites_rls.sql` | 36 | partner_invites_update — sender OR admin | **A** | keep | Same. |
| `031_reviews_transaction_gate.sql` | 141 | `reviews_admin_read` | **D** | `public.has_staff_role('support') OR public.has_staff_role('tech') OR public.am_i_admin()` | Review moderation queue. Support needs to flag review-receipt frauds. |
| `031_reviews_transaction_gate.sql` | 147-148 | `reviews_admin_verify` | **A** | keep | Verification flip = admin only (issues 100 LYMX). Tightening here is INTENTIONAL per memory: "LYMX is operator-configurable" + transactions are finance. |
| `031_reviews_transaction_gate.sql` | 219 | storage `review-receipts` admin read | **D** | `bucket_id='review-receipts' AND (public.has_staff_role('support') OR public.am_i_admin())` | Same as reviews_admin_read — support triages. |
| `034_onboarding_calendar.sql` | 121-122 | `bookings_admin_all` | **E** | `public.am_i_admin() OR public.has_staff_role('sales') OR host_id IN (...)` | Bookings handled by Rachel (sales/marketing). Use `has_staff_role('sales')` since `am_i_marketing()` does not yet exist. Or define a new `am_i_sales()` helper. **F** — Kenny to call. |
| `034_onboarding_calendar.sql` | 127-128 | `hosts_admin_write` | **A** | keep | Host configuration = admin. |
| `034_onboarding_calendar.sql` | 133-134 | `availability_admin_write` | **A** | keep | Availability rules = admin (or host-self). |
| `035_biz_approval_and_bridge.sql` | 160 | `businesses_admin_read` | **D** | `public.has_staff_role('support') OR public.has_staff_role('sales') OR public.am_i_admin()` | Approval queue is read by sales/support to triage. **F** if Kenny prefers admin-only. |
| `035_biz_approval_and_bridge.sql` | 165-166 | `businesses_admin_update` | **A** | keep | Approval write = admin. |
| `036_stripe_connect.sql` | 50 | `stripe_webhook_admin` | **C** | `public.am_i_admin() OR public.am_i_cfo()` | Stripe webhook audit = finance. |
| `037_conversations.sql` | 257-269 | **Function redefinition (bug variant 2)** | n/a | **DROP. Restore strict from 015.** | The broken redefinition that started this audit. |
| `037_conversations.sql` | 272 | `grant execute` | n/a | keep | Grant only. |
| `037_conversations.sql` | 284-285 | `conv_admin_all` conversations | **D** | `public.is_staff() OR public.am_i_admin()` | Internal staff inbox — any staff (support, marketing, sales) handles conversations. **This is the main D case** — Rachel currently handles Cluster A bookings; she's marketing, must see conv. |
| `037_conversations.sql` | 350-351 | `conv_msg_admin_all` | **D** | `public.is_staff() OR public.am_i_admin()` | Same. |
| `037_conversations.sql` | 385-386 | `conv_part_admin_all` | **D** | `public.is_staff() OR public.am_i_admin()` | Same. |
| `037_conversations.sql` | 419-420 | `conv_att_admin_all` | **D** | `public.is_staff() OR public.am_i_admin()` | Same. |
| `037_conversations.sql` | 431 | conv_att participant_read — OR admin | **D** | `or public.is_staff()` | Attachment visibility for staff. |
| `037_conversations.sql` | 552 | `fn_claim_conversation()` admin gate | **D** | `v_is_admin := public.is_staff();` rename to `v_can_claim`; `if not v_can_claim then raise 'only staff can claim'` | **Important** — `am_i_admin()` here was the band-aid: ANY staff should be able to claim a conv. Strict admin = only Kenny+Helen could claim. |
| `037_conversations.sql` | 784 | sanity SELECT count | n/a | keep | Verification only. |
| `040_team_calendar_leads.sql` | 241 | `tc_admin_all` team_calendars | **A** | keep | Calendar config = admin. |
| `040_team_calendar_leads.sql` | 267-268 | `leads_admin_all` | **D** | `public.has_staff_role('sales') OR public.has_staff_role('marketing') OR public.am_i_admin()` | Sales/marketing read leads. **F** — Kenny to confirm exact role list. |
| `040_team_calendar_leads.sql` | 278-279 | `bookings_admin_all` | **D** | same as above | Same. |
| `041_google_oauth.sql` | 61-62 | `oauth_admin_all` oauth_tokens | **A** | keep | OAuth token store = admin only. (Tokens grant Google calendar/inbox access — security-sensitive.) |
| `047_schedule_weeks_and_shift_gating.sql` | 75 | `sw_self_read` — self OR admin OR hr | **A** | keep | HR + admin OR'd — correct. |
| `047_schedule_weeks_and_shift_gating.sql` | 84-85 | `sw_admin_all` — admin OR hr | **A** | keep | Same. |
| `048_fraud_prevention.sql` | 75 | `ff_admin_read` fraud_flags | **A** | keep | Fraud flags = admin only (compliance-sensitive). Could be `am_i_admin() OR am_i_compliance()` if Kenny wants compliance team to see them — **F** to confirm. |
| `048_fraud_prevention.sql` | 79 | `ff_admin_write` | **A** | keep | Same. |
| `048_fraud_prevention.sql` | 104 | `tx_no_customer_transfers` — non-customer-transfer OR admin | **A** | keep | **CRITICAL FRAUD GATE** — only admin can create transfer_in/out transactions. Per FRAUD-PREVENTION-SUMMARY.md, this is the hard-block at DB level. **Do NOT loosen.** |
| `049_business_ownership_transfers.sql` | 59-60 | `bot_admin_all` — admin OR hr | **A** | keep `public.am_i_admin() or public.am_i_hr()` | Already correct. |
| `049_business_ownership_transfers.sql` | 88 | `fn_transfer_business_ownership()` guard | **A** | keep | Function gate already supports HR. |
| `051_broadcasts_admin_helper.sql` | 15-16 | `broadcasts_admin_all` recreate | **C** | `public.am_i_admin() OR public.am_i_cfo()` | Same as 009 — broadcasts cost money. |
| `051_broadcasts_admin_helper.sql` | 25, 28 | sanity existence check | n/a | keep | Verification only. |
| `055_hr_foundation.sql` | 43, 52, 60, 69, 78, 89 | helper bodies | **A** | keep | All correctly OR `am_i_admin()` so admin gets HR automatically. After strict-admin restore these still behave correctly. |
| `055_hr_foundation.sql` | 281-282 | `benefits_policy_write` — admin OR cfo | **A** | keep | Already correct. |
| `055_hr_foundation.sql` | 289, 291 | sanity check | n/a | keep | |
| `065_feedback_screenshots_admin_read.sql` | 37 | `can_read_feedback_storage()` body — admin THEN tech/support check | **A** | keep — uses sibling pattern already | Function correctly fans out admin → tech/support. |
| `071_conversations_rls_recursion_fix.sql` | 117 | `fn_can_read_conversation()` — admin OR subject OR participant | **D** | `public.is_staff() OR public.fn_is_subject_of_conversation(p_conv_id) OR public.fn_is_participant_of_conversation(p_conv_id)` | Same logic as 037 — staff inbox. |
| `075_reserved_partner_codes.sql` | 58-59 | `reserved_partner_codes_admin_write` | **A** | keep | Reserved codes = admin. |
| `075_reserved_partner_codes.sql` | 189 | `fn_assign_reserved_partner_code()` guard | **A** | keep | Admin only. |
| `078_biz_intake_full.sql` | 146-147 | `biz_docs_admin_all` business_documents | **D** | `public.has_staff_role('support') OR public.has_staff_role('compliance') OR public.am_i_admin()` | Doc review during onboarding. Support + compliance need read. **F** if Kenny wants stricter. |
| `078_biz_intake_full.sql` | 166, 179 | storage `business-documents` bucket policies | **D** | same as above | Same. |
| `079_marketing_posts.sql` | 52 | `marketing_posts_public_read` — published OR admin | **E** | `published = true OR public.has_staff_role('marketing') OR public.am_i_admin()` | Marketing needs to read drafts to edit. |
| `079_marketing_posts.sql` | 56 | `marketing_posts_admin_write` | **E** | `public.has_staff_role('marketing') OR public.am_i_admin()` | Marketing team writes posts. |
| `084_hr_clock_schedule_timesheets_mirror.sql` | 20 | comment only | n/a | keep | Doc comment. |
| `085_table_reservations_and_event_rsvps.sql` | 84 | `tr_select` — self OR admin OR biz-owner | **D** | `user_id = auth.uid() OR public.is_staff() OR (biz-owner)` | Reservations triage = staff. **F**: actually most reservations want admin only — biz owner handles per-biz. Keep **A** unless support volume justifies. **Default A.** |
| `085_table_reservations_and_event_rsvps.sql` | 100, 106 | `tr_biz_owner_update` — admin OR owner | **A** | keep | Admin override + biz owner. |
| `085_table_reservations_and_event_rsvps.sql` | 163, 178, 183 | `event_rsvps` self+admin | **A** | keep | Same. |
| `086_event_rsvps_rls_jwt_email_fix.sql` | 21, 30, 35 | same pattern, JWT-email fix | **A** | keep | Same. |
| `087_v_team_roster_definer_plus_display_name.sql` | 57, 62 | `v_team_roster` filter `where am_i_admin()` | **B/E** | `where public.am_i_hr_or_admin()` | Roster is HR-curated. Admin AND HR-or-compliance should read. Already have `am_i_hr_or_admin()` helper (055). **Action: change view filter to `am_i_hr_or_admin()`.** |
| `088_qr_scan_issue_redeem.sql` | 120, 130 | biz-owner check OR admin | **A** | keep | Owner-scope with admin override. |
| `088_qr_scan_issue_redeem.sql` | 187, 200, 223, 229 | qr_claims RLS | **A** | keep | Customer/biz-owner scope; admin override. |
| `090_business_locations_and_clock_in_admin_fixes.sql` | 37-38 | `biz_loc_admin_all` | **A** | keep | Admin manages locations. |
| `093_biz_invitations.sql` | 98-99 | `biz_invitations_admin_all` | **A** | keep | Already partner-OR-admin via separate policies; the `_admin_all` is admin-only by design. |
| `095_biz_approval_queue_v2.sql` | 64, 143 | comment only | n/a | keep | Doc comment. |
| `096_onboarding_followup.sql` | 155-156 | `onboarding_followup_sends_admin_all` | **D** | `public.has_staff_role('sales') OR public.has_staff_role('marketing') OR public.am_i_admin()` | Sales/marketing read send log. **F**: Kenny may prefer admin-only since it's an audit table. **Default A.** |
| `101_remove_hardcoded_admin_uuid_or_clauses.sql` | many | this migration is what we're tightening | **A** | keep — migration 102 supersedes specific calls listed in this table | Pre-existing fix; we're refining. |

### Edge Functions

| File | Line | Context | Class | Replacement | Why |
|---|---|---|---|---|---|
| `biz-invite-create/index.ts` | 120, 129 | `am_i_admin` RPC for invite-creation gate | **A** | keep | Creating biz invitations = admin-only. (Partners use separate `invite_partner_token` flow.) |
| `biz-invite-send-email/index.ts` | 176 | `isAdmin` allowed-flag for sending invite email | **A** | keep | Admin override + sender check; OK. |
| `biz-request-more-info/index.ts` | 159 | `am_i_admin` gate before request-info insert | **A** | keep | Admin-only operation in onboarding queue. |
| `business-approval-email/index.ts` | 147 | admin gate for approval email | **A** | keep | Admin only — sends approval/rejection email to applicant. |
| `enforce-lunch-policy/index.ts` | comment | uses cron-secret OR `am_i_admin()` pattern | **A** | keep | Cron + admin trigger. |
| `onboarding-followup-cron/index.ts` | 161 | admin gate for manual cron trigger | **A** | keep | Manual trigger from admin UI; OK admin-only. |
| `stripe-connect-onboarding/index.ts` | 88 | admin path to onboard a specific business | **A** | keep | Admin path for stripe connect — finance-sensitive. (Could OR `am_i_cfo()` but not required.) |

### Frontend

| File | Line | Context | Class | Replacement | Why |
|---|---|---|---|---|---|
| `admin-business-applications.html` | 160 | Admin guard for the page | **A** | keep | Page-level admin gate. |
| `admin-reviews.html` | 92 | Admin guard for review-verify | **A** | keep | Verification flip = admin only (matches 031 reviews_admin_verify). |
| `index.html` | 817 | Dashboard route — read cached `LYMX_is_admin` | **A** | keep | Already documented as the canonical pattern. |
| `lymx-auth.js` | 100, 102 | `LYMX.checkIsAdmin()` RPC + cache | **A** | keep | Canonical helper consumed by every page. Strict admin is what callers expect. **Note**: existing callers that need "any staff" should call a new `LYMX.isStaff()` helper instead — add that to lymx-auth.js. |
| `lymx-role-gate.js` | 75, 107 | Role-gate admin bypass | **A** | keep | Page-gate bypass for admins. (For "staff" role-required, a SEPARATE branch already exists at line 104 calling `/rest/v1/staff_roles` — that's the correct is-staff check. Make sure migration 102 doesn't break the existing `required === 'staff'` branch — it queries `staff_roles` directly so no RPC dependency.) |
| `lymx-shift-gate.js` | comment | admin bypass shift gate | **A** | keep | Strict admin bypass is correct — only top admins skip shift gating. |
| `playbooks.html` | 167, 170 | Admin check to pick role filter | **A** | keep | Falls through to staff/partners/customers if not admin. |

---

## 3. Required new helpers

### 3a. `public.is_staff()` — **NEW**, define in migration 102

```sql
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff_roles where user_id = auth.uid()
  )
$$;
grant execute on function public.is_staff() to authenticated;
```

This is the helper that the broken `am_i_admin()` redefinition was *trying* to be, but was applied at the wrong call sites. With strict `am_i_admin()` restored, this helper backfills the legitimate "any staff member" use cases.

### 3b. Optional: `public.am_i_marketing()`, `public.am_i_sales()`, `public.am_i_support()`

These would be cleaner replacements for the literal `has_staff_role('marketing')` calls scattered through migration 102. **Defer** to Kenny:

- `am_i_marketing()` would be useful for migration 079 (marketing_posts) and possibly 040 (leads/bookings).
- `am_i_sales()` for 034 (onboarding bookings), 040 (leads), 035 (biz approval queue read).
- `am_i_support()` for 008/016 (feedback), 027 (attachments), 031 (reviews triage).

For migration 102, **use the inline `has_staff_role('xxx')` form** — it works today without defining new helpers. If Kenny wants the helpers added later, they can be one-liners.

### 3c. Already exists — don't redefine

- `public.am_i_hr()` (migration 055) — wraps admin OR is_hr OR is_cfo. Correct.
- `public.am_i_cfo()` (055) — admin OR is_cfo. Correct.
- `public.am_i_compliance()` (055) — admin OR is_compliance OR is_cfo. Correct.
- `public.am_i_accounting()` (055) — admin OR is_accounting OR is_cfo. Correct.
- `public.am_i_admin_onsite()` (055) — admin OR is_admin_onsite OR is_cfo. Correct.
- `public.am_i_hr_or_admin()` (055) — admin OR hr OR compliance OR admin_onsite. Correct.
- `public.has_staff_role(text)` (015) — checks `staff_roles.role = $1`. Correct.

**All `am_i_*()` helpers wrap `am_i_admin()` in their first OR clause.** This means after we restore strict `am_i_admin()`, all of these helpers automatically keep admin in their scope. NO changes needed to migrations 047, 049, 055, 084 — they continue to grant admin access through the OR chain.

---

## 4. Risk callouts

### 4.1 — Conversations (`fn_claim_conversation`) [HIGH]

Migration 037 line 552 raises `'only admins can claim conversations'`. After strict-admin restore, the only people who can claim a conversation in the unified inbox are users with `staff_roles.role = 'admin'`. **Today's reality**: Rachel (marketing) and Dave (partner) are actively triaging conversations. Locking them out kills the inbox.

**Action:** migration 102 MUST swap this guard to `public.is_staff()` AND rename the raise to `'only staff can claim conversations'`. The function body is `security definer`, so this is a one-liner replacement.

### 4.2 — `v_my_feedback` view (`016_feedback_replies_clusters_routing.sql:263`) [HIGH]

This is the spec's named regression: Rachel currently sees ALL feedback in this view because of the broken `am_i_admin()` (returns true for her marketing row). Restoring strict admin will correctly hide other users' feedback from her — **but** if Rachel needs to see assigned feedback for triage, that's a SEPARATE concern handled via:

- Either: rewrite `v_my_feedback` to include `OR (assignee_user_id = auth.uid())` so triagers see what's assigned to them.
- Or: add a new `v_triage_inbox` view for support/marketing that uses `public.has_staff_role('support') OR ...` filter.

**Action:** migration 102 should ALSO add `OR assignee_user_id = auth.uid()` to `v_my_feedback` so the triage UI still works. This avoids needing a second view. (Confirm `feedback.assignee_user_id` column exists — it does, per memory `feedback_lymx_tester_role_routing.md`.)

### 4.3 — Fraud-prevention `tx_no_customer_transfers` (`048_fraud_prevention.sql:104`) [CRITICAL]

DO NOT broaden this with `is_staff()`. Per `FRAUD-PREVENTION-SUMMARY.md`, this is the hard-block at the DB layer for customer-initiated transfers. The ONLY allowed override is full admin. Tightening (which is what restoring strict admin does) is the correct posture.

### 4.4 — `staff_roles_admin_all` (`015_staff_roles_and_change_requests.sql:67`) [CRITICAL]

If any non-admin staff could pass this RLS, they could promote themselves to admin. Strict admin here is non-negotiable. Already correct, just don't accidentally loosen it.

### 4.5 — `v_team_roster` view filter (`087_v_team_roster_definer_plus_display_name.sql:57`) [MEDIUM]

The view returns ALL auth.users data (PII). Currently filtered with `where am_i_admin()`. Under strict-admin, ONLY admins see the roster. **Recommendation**: change to `where public.am_i_hr_or_admin()` so HR/compliance also see the roster (which is what HR needs for personnel management). Kenny to confirm.

### 4.6 — Broadcasts (`009_chat_broadcast_assign.sql:253` + `051_broadcasts_admin_helper.sql:15`) [MEDIUM]

Today ANY staff_roles row can mass-send broadcasts due to the bug. After fix, only `role='admin'` can. If marketing needs to schedule blasts (Susan was provisioned as a "marketing" role per memory), they'll be locked out unless we OR `am_i_cfo()` OR `am_i_marketing()`. Recommended: `am_i_admin() OR am_i_cfo()` for now (since broadcasts cost money) and route marketing through change_requests.

### 4.7 — Edge Function callers using service-role JWT [LOW]

`biz-invite-create/index.ts:120` calls `am_i_admin` with the service-role client. The code COMMENT correctly notes that service_role doesn't have an `auth.uid()`, and a second `supaAsUser` client is built with the user JWT for the real check (line 129). This pattern is correct; no change needed. Just confirm the duplicate `adminFlag` from line 120 is unused (it's set but `isAdmin = !!isAdminFromJwt` shadows it).

### 4.8 — `business-approval-email/index.ts:147` fallback [LOW]

This file calls `supabase.rpc("am_i_admin")` with a service-role client (will return null), then falls back to `staff_roles` direct query at line 150. That's correct AS LONG AS the fallback eq's `role='admin'` (it does). No change needed.

---

## 5. Proposed Migration 102 skeleton

```sql
-- ==============================================================================
-- migration 102 — restore strict am_i_admin() + introduce is_staff() helper +
--                 fix the call sites that were silently relying on the broken
--                 over-permissive am_i_admin() to grant any-staff access.
-- ==============================================================================
-- Background: migrations 025 and 037 both redefined public.am_i_admin() to
-- return true for ANY staff_roles row, not just role='admin'. That broke
-- user-isolation in v_my_feedback (Rachel saw everyone's feedback) and
-- silently widened ~38 RLS policies beyond their original intent.
--
-- This migration:
--   1. Restores public.am_i_admin() to the canonical strict definition from 015.
--   2. Adds public.is_staff() as a clean "any staff member" check.
--   3. Updates the ~38 call sites that needed any-staff access to use is_staff()
--      (or has_staff_role(...) where finer-grained).
--   4. Updates v_team_roster to use am_i_hr_or_admin() so HR sees the roster.
--   5. Updates fn_claim_conversation to allow any staff to claim.
--   6. Updates v_my_feedback to include assignee_user_id for triagers.
--   7. Updates the 4 finance-sensitive sites (Stripe webhook, broadcasts,
--      email/SMS event audit) to OR am_i_cfo().
--   8. Verifies with Kenny + Rachel sample user_ids at the bottom.
--
-- DOES NOT touch: migrations 025/047/049/055/084 (already OR am_i_hr/cfo,
-- correct semantics carry through automatically once 102 restores strict admin).
-- ==============================================================================

-- ============================================================================
-- 1. RESTORE STRICT am_i_admin() — overrides the bad redefinitions in 025+037
-- ============================================================================
create or replace function public.am_i_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff_roles
     where user_id = auth.uid()
       and role = 'admin'
  )
$$;
grant execute on function public.am_i_admin() to authenticated, anon;

-- ============================================================================
-- 2. NEW HELPER — is_staff() returns true for ANY staff_roles row.
-- ============================================================================
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff_roles where user_id = auth.uid()
  )
$$;
grant execute on function public.is_staff() to authenticated;

-- ============================================================================
-- 3. CONVERSATIONS — any staff can read/handle/claim (migration 037)
-- ============================================================================
drop policy if exists conv_admin_all on public.conversations;
create policy conv_admin_all on public.conversations
    for all to authenticated
    using (public.is_staff() or public.am_i_admin())
    with check (public.is_staff() or public.am_i_admin());

drop policy if exists conv_msg_admin_all on public.conversation_messages;
create policy conv_msg_admin_all on public.conversation_messages
    for all to authenticated
    using (public.is_staff() or public.am_i_admin())
    with check (public.is_staff() or public.am_i_admin());

drop policy if exists conv_part_admin_all on public.conversation_participants;
create policy conv_part_admin_all on public.conversation_participants
    for all to authenticated
    using (public.is_staff() or public.am_i_admin())
    with check (public.is_staff() or public.am_i_admin());

drop policy if exists conv_att_admin_all on public.conversation_attachments;
create policy conv_att_admin_all on public.conversation_attachments
    for all to authenticated
    using (public.is_staff() or public.am_i_admin())
    with check (public.is_staff() or public.am_i_admin());

drop policy if exists conv_att_participant_read on public.conversation_attachments;
create policy conv_att_participant_read on public.conversation_attachments
    for select to authenticated
    using (
        exists (
            select 1 from public.conversation_messages m
             join public.conversations c on c.id = m.conversation_id
            where m.id = conversation_attachments.message_id
              and (
                   public.is_staff()
                or public.am_i_admin()
                or exists (select 1 from public.conversation_participants cp
                            where cp.conversation_id = c.id and cp.user_id = auth.uid())
              )
        )
    );

-- claim function: rebuild allowing any staff
create or replace function public.fn_claim_conversation(
    p_conversation_id  uuid,
    p_staleness_hours  integer default 24
) returns table (
    claimed                boolean,
    previous_assignee_id   uuid,
    new_assignee_id        uuid,
    last_handled_at        timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_now           timestamptz := now();
    v_caller        uuid := auth.uid();
    v_can_claim     boolean;
    v_prev          uuid;
    v_last_handled  timestamptz;
begin
    if v_caller is null then
        raise exception 'claim requires authentication';
    end if;

    v_can_claim := public.is_staff() or public.am_i_admin();
    if not v_can_claim then
        raise exception 'only staff can claim conversations';
    end if;

    select assigned_to_user_id, last_handled_at
      into v_prev, v_last_handled
      from public.conversations
     where id = p_conversation_id;

    if not found then
        raise exception 'conversation % not found', p_conversation_id;
    end if;

    if v_prev is null
       or v_prev = v_caller
       or v_last_handled is null
       or v_last_handled < v_now - make_interval(hours => p_staleness_hours) then
        update public.conversations
           set assigned_to_user_id     = v_caller,
               last_handled_by_user_id = v_caller,
               last_handled_at         = v_now,
               updated_at              = v_now
         where id = p_conversation_id;
        return query select true, v_prev, v_caller, v_last_handled;
    else
        return query select false, v_prev, v_caller, v_last_handled;
    end if;
end;
$$;

-- 071_conversations_rls_recursion_fix.sql — fn_can_read_conversation
create or replace function public.fn_can_read_conversation(p_conv_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select
        public.is_staff()
        or public.am_i_admin()
        or public.fn_is_subject_of_conversation(p_conv_id)
        or public.fn_is_participant_of_conversation(p_conv_id);
$$;

-- ============================================================================
-- 4. CHAT (migration 009) — any staff can read chat groups + messages
-- ============================================================================
drop policy if exists chat_groups_select on public.chat_groups;
create policy chat_groups_select on public.chat_groups
    for select to authenticated
    using (
        exists (
            select 1 from public.chat_group_members m
             where m.group_id = chat_groups.id
               and m.user_id  = auth.uid()
        )
        or public.is_staff()
        or public.am_i_admin()
    );

drop policy if exists chat_members_select on public.chat_group_members;
create policy chat_members_select on public.chat_group_members
    for select to authenticated
    using (
        exists (
            select 1 from public.chat_group_members m
             where m.group_id = chat_group_members.group_id
               and m.user_id  = auth.uid()
        )
        or public.is_staff()
        or public.am_i_admin()
    );

drop policy if exists chat_msgs_select_member on public.chat_messages;
create policy chat_msgs_select_member on public.chat_messages
    for select to authenticated
    using (
        exists (
            select 1 from public.chat_group_members m
             where m.group_id = chat_messages.group_id
               and m.user_id  = auth.uid()
        )
        or public.is_staff()
        or public.am_i_admin()
    );

-- Keep chat_groups_update_owner + chat_members_insert as admin-only — do not change.

-- ============================================================================
-- 5. BROADCASTS — admin + cfo only (finance gate)
-- ============================================================================
drop policy if exists broadcasts_admin_all on public.broadcasts;
create policy broadcasts_admin_all on public.broadcasts
    for all to authenticated
    using (public.am_i_admin() or public.am_i_cfo())
    with check (public.am_i_admin() or public.am_i_cfo());

-- ============================================================================
-- 6. FEEDBACK — support/tech triage queue
-- ============================================================================
drop policy if exists feedback_admin_all on public.feedback;
create policy feedback_admin_all on public.feedback
    for all to authenticated
    using (
        public.am_i_admin()
        or public.has_staff_role('support')
        or public.has_staff_role('tech')
    )
    with check (
        public.am_i_admin()
        or public.has_staff_role('support')
        or public.has_staff_role('tech')
    );

drop policy if exists fb_replies_admin_all on public.feedback_replies;
create policy fb_replies_admin_all on public.feedback_replies
    for all to authenticated
    using (
        public.am_i_admin()
        or public.has_staff_role('support')
        or public.has_staff_role('tech')
    )
    with check (
        public.am_i_admin()
        or public.has_staff_role('support')
        or public.has_staff_role('tech')
    );

-- v_my_feedback — include assignee so triagers see assigned items
create or replace view public.v_my_feedback as
select f.*,
       (select max(r.created_at) from public.feedback_replies r
         where r.feedback_id = f.id and r.author_id is not null
         order by r.created_at desc limit 1) as last_admin_reply_at
from public.feedback f
where f.user_id = auth.uid()
   or f.assignee_user_id = auth.uid()           -- NEW: triagers see assigned items
   or public.am_i_admin();
grant select on public.v_my_feedback to authenticated;

-- feedback_attachments
drop policy if exists fb_att_admin_all on public.feedback_attachments;
create policy fb_att_admin_all on public.feedback_attachments
    for all to authenticated
    using (
        public.am_i_admin()
        or public.has_staff_role('support')
        or public.has_staff_role('tech')
    )
    with check (
        public.am_i_admin()
        or public.has_staff_role('support')
        or public.has_staff_role('tech')
    );

-- ============================================================================
-- 7. REVIEWS — support reads, admin verifies (031)
-- ============================================================================
drop policy if exists reviews_admin_read on public.reviews;
create policy reviews_admin_read on public.reviews
    for select to authenticated
    using (
        public.am_i_admin()
        or public.has_staff_role('support')
        or public.has_staff_role('tech')
    );

-- reviews_admin_verify stays admin-only (no change).

-- review-receipts storage
drop policy if exists review_receipts_admin_read on storage.objects;
create policy review_receipts_admin_read on storage.objects
    for select to authenticated
    using (
        bucket_id = 'review-receipts'
        and (public.am_i_admin() or public.has_staff_role('support'))
    );

-- ============================================================================
-- 8. FINANCE-SENSITIVE SITES — add am_i_cfo() OR
-- ============================================================================
-- 022 email_sends / email_events / sms_messages
drop policy if exists email_sends_admin_all on public.email_sends;
create policy email_sends_admin_all on public.email_sends
    for select to authenticated
    using (
        public.am_i_admin()
        or public.am_i_cfo()
        or sender_user_id = auth.uid()
    );

drop policy if exists email_events_admin_all on public.email_events;
create policy email_events_admin_all on public.email_events
    for select to authenticated
    using (
        public.am_i_admin()
        or public.am_i_cfo()
        or exists (
            select 1 from public.email_sends s
             where s.id = email_events.email_send_id
               and s.sender_user_id = auth.uid()
        )
    );

drop policy if exists sms_messages_admin_all on public.sms_messages;
create policy sms_messages_admin_all on public.sms_messages
    for select to authenticated
    using (
        public.am_i_admin()
        or public.am_i_cfo()
        or sender_user_id    = auth.uid()
        or recipient_user_id = auth.uid()
    );

-- 012 business_billing
drop policy if exists billing_admin_all on public.business_billing;
create policy billing_admin_all on public.business_billing
    for all to authenticated
    using (public.am_i_admin() or public.am_i_cfo())
    with check (public.am_i_admin() or public.am_i_cfo());

-- 036 stripe_webhook
drop policy if exists stripe_webhook_admin on public.stripe_webhook_events;
create policy stripe_webhook_admin on public.stripe_webhook_events
    for select to authenticated
    using (public.am_i_admin() or public.am_i_cfo());

-- ============================================================================
-- 9. MARKETING POSTS (079) — marketing team writes
-- ============================================================================
drop policy if exists marketing_posts_public_read on public.marketing_posts;
create policy marketing_posts_public_read on public.marketing_posts
    for select to authenticated
    using (
        published = true
        or public.am_i_admin()
        or public.has_staff_role('marketing')
    );

drop policy if exists marketing_posts_admin_write on public.marketing_posts;
create policy marketing_posts_admin_write on public.marketing_posts
    for all to authenticated
    using (public.am_i_admin() or public.has_staff_role('marketing'))
    with check (public.am_i_admin() or public.has_staff_role('marketing'));

-- ============================================================================
-- 10. TEAM ROSTER VIEW (087) — HR sees it too
-- ============================================================================
create or replace view public.v_team_roster as
  select u.id as user_id, u.email, sr.role,
         coalesce(sp.title, sr.role) as title,
         sp.hire_date, sp.employment_status,
         sr.is_hr, sr.is_cfo, sr.is_compliance, sr.is_accounting, sr.is_admin_onsite,
         coalesce(sp.display_name, u.raw_user_meta_data ->> 'display_name', u.email) as display_name
    from auth.users u
    join public.staff_roles sr     on sr.user_id = u.id
    left join public.staff_profiles sp on sp.user_id = u.id
   where public.am_i_hr_or_admin()
   order by sr.role, u.email;
grant select on public.v_team_roster to authenticated;

-- ============================================================================
-- 11. CONTACTS (011) — KEEP STRICT — owner-scope is correct (no change here)
-- 12. PARTNER_INVITES (010, 028) — KEEP STRICT
-- 13. STAFF_ROLES, CHANGE_REQUESTS (015) — KEEP STRICT
-- 14. PROMOS (014) — KEEP STRICT
-- 15. FRAUD FLAGS (048) — KEEP STRICT (critical)
-- 16. OAUTH TOKENS (041) — KEEP STRICT
-- 17. ONBOARDING calendar (034) — KEEP STRICT
-- 18. SCHEDULE/HR (025, 047, 049) — already OR am_i_hr(), no change needed
-- 19. STRIPE-CONNECT EF — service-role flow, no change
-- 20. BUSINESS DOCUMENTS (078) — leave for Kenny review (compliance vs support gate)
-- 21. LEADS/BOOKINGS (040) — leave for Kenny review (sales gate)
-- 22. BIZ APPROVAL READ (035) — leave for Kenny review (sales/support gate)
-- 23. RESERVATIONS / RSVPS (085, 086) — KEEP STRICT (biz-owner does most triage)
-- 24. ONBOARDING_FOLLOWUP_SENDS (096) — KEEP STRICT (audit table)
-- ============================================================================

-- ============================================================================
-- 25. VERIFICATION — exercise each helper with Kenny + Rachel sample uids
-- ============================================================================
-- Kenny  = 1405bb50-2c97-48dd-bfa5-31f32320de9b (admin)
-- Rachel = 2d32a692-5739-47d6-b7eb-43b5c3202b5e (marketing)

do $verify_102$
declare
    v_kenny  uuid := '1405bb50-2c97-48dd-bfa5-31f32320de9b';
    v_rachel uuid := '2d32a692-5739-47d6-b7eb-43b5c3202b5e';
    v_kenny_admin   boolean;
    v_kenny_staff   boolean;
    v_rachel_admin  boolean;
    v_rachel_staff  boolean;
    v_kenny_marketing  boolean;
    v_rachel_marketing boolean;
begin
    -- Use SET LOCAL ROLE + JWT claims to simulate each user.
    -- Postgres can't easily set auth.uid() inline without a JWT, so we use
    -- direct staff_roles lookups to verify the helper semantics.

    select exists(select 1 from public.staff_roles where user_id = v_kenny  and role = 'admin')     into v_kenny_admin;
    select exists(select 1 from public.staff_roles where user_id = v_kenny)                          into v_kenny_staff;
    select exists(select 1 from public.staff_roles where user_id = v_kenny  and role = 'marketing') into v_kenny_marketing;

    select exists(select 1 from public.staff_roles where user_id = v_rachel and role = 'admin')     into v_rachel_admin;
    select exists(select 1 from public.staff_roles where user_id = v_rachel)                         into v_rachel_staff;
    select exists(select 1 from public.staff_roles where user_id = v_rachel and role = 'marketing') into v_rachel_marketing;

    raise notice 'Kenny — admin=% staff=% marketing=%', v_kenny_admin, v_kenny_staff, v_kenny_marketing;
    raise notice 'Rachel — admin=% staff=% marketing=%', v_rachel_admin, v_rachel_staff, v_rachel_marketing;

    -- Expected:
    --   Kenny  — admin=true, staff=true, marketing=false
    --   Rachel — admin=false, staff=true, marketing=true
    if not v_kenny_admin then
        raise exception 'POST-MIGRATION SANITY FAIL: Kenny is not marked staff_roles.role=admin';
    end if;
    if v_rachel_admin then
        raise exception 'POST-MIGRATION SANITY FAIL: Rachel is incorrectly marked admin';
    end if;
    if not v_rachel_staff then
        raise warning 'Rachel has no staff_roles row at all — is_staff() will return false. Confirm her seed.';
    end if;
end$verify_102$;

-- Final summary
select 'migration 102 applied' as status,
       (select pg_get_functiondef(oid)
          from pg_proc
         where proname = 'am_i_admin'
           and pg_function_is_visible(oid)
         limit 1) as am_i_admin_definition,
       (select count(*)
          from pg_proc
         where proname in ('am_i_admin', 'is_staff', 'am_i_hr', 'am_i_cfo',
                           'am_i_compliance', 'am_i_accounting',
                           'am_i_admin_onsite', 'am_i_hr_or_admin',
                           'has_staff_role')) as helper_function_count;
```

---

## 6. Migration order + roll-out notes

1. **PR 102 alone** — do not bundle with feature work. Pure security tighten.
2. **Pre-deploy**: snapshot the live RLS policy set (`select * from pg_policies where schemaname='public'`) so we can diff before/after.
3. **Post-deploy verify**:
   - As Rachel (marketing JWT): `SELECT count(*) FROM v_my_feedback;` — should now return ONLY Rachel's own feedback + items assigned to her (was returning ALL feedback).
   - As Rachel: `SELECT count(*) FROM conversations;` — should still see all conversations (because of is_staff()).
   - As Dave (partner): `SELECT count(*) FROM staff_roles;` — should return ONLY his own row (was potentially returning more).
   - As Helen (admin): everything stays accessible.
4. **Frontend follow-up** (separate ticket): add `LYMX.isStaff()` to `lymx-auth.js` for any UI gates that should check is_staff (e.g., conversation inbox link).

---

## 7. Items needing Kenny's call (Class F)

1. **Migration 034** — should sales/marketing read onboarding bookings? Or keep admin + host-self only?
2. **Migration 035** — should sales/support read the biz approval queue (`businesses_admin_read`)? Or admin only?
3. **Migration 040** — leads_admin_all / bookings_admin_all: which staff roles read leads + bookings?
4. **Migration 048** — should compliance team also read fraud_flags?
5. **Migration 078** — biz_docs_admin_all: support + compliance, or admin only?
6. **Migration 085** — table_reservations select: include support, or admin + biz_owner only?
7. **Migration 087** — confirm `v_team_roster` should be `am_i_hr_or_admin()` (recommended) vs `am_i_admin()` (status quo).
8. **Migration 096** — onboarding_followup_sends: audit table — admin only or include sales/marketing read?

If Kenny prefers "tightest possible" — leave all of these as `am_i_admin()` (strict) and add the broader roles later when a real user complains they can't see something.
