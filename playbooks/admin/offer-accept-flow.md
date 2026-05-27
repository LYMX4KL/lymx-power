---
slug: admin-offer-accept-flow
title: How the public accept-offer magic-link flow works
project: LYMX Power
role: admin
prereqs:
  - migration_121_applied
  - migration_056_applied (trigger tg_offer_accepted_spawn_onboarding exists)
duration_min: 2
difficulty: easy
last_verified: 2026-05-27
related:
  - hr-onboarding-end-to-end
supersedes: null
---

# How the public accept-offer magic-link flow works

When Helen clicks **Send to candidate** in the Offer pipeline, three things happen in one round-trip:

1. A one-time-use UUID token is generated client-side (`crypto.randomUUID()` in modern browsers, polyfill fallback).
2. The token + a 14-day expiry are written to the offer row (`accept_token`, `accept_token_expires_at`, `accept_token_issued_at`), and `status` flips to `sent` with `sent_at = now()`.
3. A copy-paste email body opens in a modal with the magic-link URL baked in. Helen pastes it into her email client (or hits "Copy as mailto link" to launch Gmail/Outlook).

The candidate gets an email, clicks the link, lands on `/accept-offer.html?t=<uuid>`. The page calls `fn_offer_resolve_by_token` (security-definer RPC) to fetch the offer summary, renders it, and shows a green **✓ Accept this offer** button. Clicking accept calls `fn_offer_accept_by_token` which flips `offers.status='accepted'` + `accepted_at=now()` + `accepted_via_token=true` + clears the token.

The existing trigger `tg_offer_accepted_spawn_onboarding` (migration 056) fires on the status flip and:
- Marks the `job_applications` row as `hired`
- Inserts a `staff_profiles` row for the new hire
- Seeds onboarding tasks from `onboarding_task_templates` matching the offer's `target_role` and employment_type
- Marks the `jobs` row as `filled` (if linked)

By the time Helen wakes up the next morning, the personnel file + onboarding tasks are ready.

## Why this exists

Before 2026-05-27, candidates had no self-serve path. Helen had to manually flip `offers.status='accepted'` in the queue when a candidate emailed back saying "yes." That broke in three ways:
1. Helen sometimes forgot to flip the status → trigger never fires → no personnel record → first-day surprise.
2. Status flips weren't auditable (who said yes, when?).
3. No "binding moment" — the candidate's email might be ambiguous; the magic-link click is unambiguous.

The new flow eliminates all three: the candidate's click IS the acceptance, the timestamp is recorded, and the trigger fires automatically.

## Token semantics

- **One-time-use:** the token is cleared after a successful accept, so the link can't be reused or shared.
- **Expiry:** default 14 days. Helen can rescind earlier by clicking **Rescind** on the offer row (flips status to `rescinded` and the resolve RPC starts returning `offer_status_not_sent`).
- **Per-offer:** if you re-send the same offer, generate a new token (re-click Send to candidate — the previous token is overwritten).
- **No PII in URL:** the token is a UUID v4. Reading the URL tells you nothing about the candidate.

## What the candidate sees

1. **Loading state** — "Loading your offer…" for ~500ms while the RPC resolves.
2. **Offer summary card** — Position, Start date, Pay, Employment type, Work mode, Location, Role family (if specified), Sign-on bonus (if specified). Plus a "📄 Read the full offer letter" link if `offer_letter_path` is set.
3. **Accept row** — A clear disclaimer ("clicking is binding"), expiry stamp, and the green Accept button.
4. **Confirm dialog** — Native browser confirm with binding-language reminder.
5. **Success screen** — Replaces the card with a celebratory "Welcome to LYMX!" + next-steps blurb.

## Error states

| What the candidate sees | What happened | Fix |
|---|---|---|
| "Missing token" | URL has no `?t=` | They clicked a stripped link. Re-send. |
| "This link is invalid or has already been used" | Token cleared (accept succeeded), or admin rescinded, or token never existed | Check status on admin side; resend if appropriate. |
| "This link expired" | More than 14 days since Helen sent it | Click Send to candidate again to issue a fresh token. |
| "This offer is no longer pending" | status is no longer `sent` (was accepted/declined/rescinded) | Probably resolved already; ask candidate what they see. |

## Admin-side audit

After a candidate accepts, the offer row has:
- `status = 'accepted'`
- `accepted_at = <UTC timestamp>`
- `accepted_via_token = true` (distinguishes self-accept from Helen-manual-accept)
- `accept_token = null` (cleared on success)
- `accept_token_expires_at` preserved (for forensics if you need to reconstruct when the link was issued)

To find rows where the candidate self-accepted: `SELECT * FROM offers WHERE accepted_via_token = true`.

## Data sources

- **`offers`** (table, migration 056 + new columns from migration 121)
- **`job_applications`** (read-only via the resolve RPC, only first_name/last_name/email exposed)
- **`fn_offer_resolve_by_token(uuid)`** (security-definer RPC, public-callable)
- **`fn_offer_accept_by_token(uuid)`** (security-definer RPC, public-callable)
- **`tg_offer_accepted_spawn_onboarding`** (trigger, migration 056) — the side-effect engine

## Out-of-scope for v1

- **Auto-email:** Helen still pastes the body into her own mail client. The "auto-send via Resend" path is the same SES placeholder env bug that blocks the broader invite/broadcast flow; until that's resolved we want human-from-human emails.
- **Counter-offer flow:** if the candidate doesn't accept and wants to negotiate, they reply to Helen's email. There's no in-app "counter" form. Helen generates a revised offer (Step 1) and rescinds the original.
- **Multi-signer offers:** v1 assumes one applicant per offer. If we ever need joint offers (rare in our context) we'll extend the token model.
