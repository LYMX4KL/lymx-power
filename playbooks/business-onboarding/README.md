# Business onboarding — end-to-end flow

> The full sequence from "Kenny meets a prospect merchant" to "customer redeems LYMX at that merchant."
>
> Each step below has its own playbook page. Reading order is the numeric prefix. Roles change between steps — the table calls out who does what.
>
> Source-of-truth audit doc: `LYMX Power\audits\BIZ-ONBOARDING-GAPS-2026-05-26.md`.

## Steps

| # | Step | Role | Status |
|---|---|---|---|
| 1 | [Invite a business](01-invite.md) | Admin or Partner | ✅ Shipped 2026-05-26 |
| 2 | Sign up | Business owner | 📋 Planned (Module 2 — surfaces existing biz-signup flow) |
| 3 | Admin approves | Admin | 📋 Planned (Module 2) |
| 4 | Approval email + required 20-min call | Business owner | 📋 Planned (Module 3) |
| 5 | Book the 20-min call with Rachel | Business owner | 📋 Planned (Module 4) |
| 6 | Issuing LYMX from the POS | Business owner | 📋 Planned (Module 5 — wallet pipeline unification) |
| 7 | Customer redeems LYMX at the business | Customer | 📋 Planned (Module 6) |

## How a real onboarding moves through these

1. Kenny (or a partner) meets a prospect — could be a chamber-of-commerce event, a referral from an existing customer, or cold outreach.
2. They use the **Invite a business** flow (step 1) to send the prospect a tracked link. The link pre-fills the prospect's name + email on the signup form.
3. The prospect clicks the link and fills out the signup form (step 2). Their submission lands in the admin queue.
4. Kenny (or a delegated admin) reviews and approves or rejects (step 3). On approve, an automatic email goes out.
5. The approval email tells the new business owner to book a required 20-minute walkthrough with Rachel (step 4 → step 5). Rachel wires up their dashboard and verifies their first issuance.
6. The business starts issuing LYMX to its customers via the POS (step 6).
7. Customers earn, then redeem (step 7) at the same business — closing the loop.

## Module mapping

Each step ships with a backend module (one commit each). The module numbers below match the audit doc's roadmap:

- Module 1 (this commit, 2026-05-26): invitation system — table, EFs, admin + partner UI, biz-signup prefill. Step 1's playbook lands here.
- Module 2: approval queue v2 — surface invitation source on the application card, "request more info" button.
- Module 3: approval email v2 + nightly follow-up cron for businesses that didn't book within 3 days.
- Module 4: 20-min slot + Daily.co room + call-summary email wiring for `book-onboarding-call.html`.
- Module 5: wallet + transactions pipeline unification — the load-bearing fix behind "0 LYMX balance" on every page.
- Module 6: customer redemption end-to-end.

Each module ships its playbook page in the same commit per Rule 0 of `PLAYBOOK-CREATION-RULES.md`.
