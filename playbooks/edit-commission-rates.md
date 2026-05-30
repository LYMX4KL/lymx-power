---
slug: edit-commission-rates
title: Edit commission rates & projector categories (no code)
project: LYMX Power
role: admin
prereqs: [signed_in_as_admin]
duration_min: 4
last_revised: 2026-05-30
---

# Edit commission rates & projector categories

Everything the income system pays from lives in two tables, now editable from one admin page —
no SQL, no redeploy. Open **Commission Config** (sidebar → Admin) or `/admin-commission-config.html`.

## Commission rates
The top card holds every rate the engine, projector, comp plan, and calculator read:
activation bonuses ($), founding speed bonus + its 5-in-3-months trigger, the transaction-fee %
(charged per side — issued AND redeemed), the direct/G1/G2/G3 override %s, and the monthly-fee
free months. Edit, add a change note, **Save rates**.

> Changes affect **future** accruals only — already-settled commissions never change. New numbers
> apply on the next commission run and immediately on the projector/comp pages.

## Projector categories
The second card edits the per-business-type LYMX volumes (café, fast food, …) that drive the
income projector's category economics. Tune issued/redeemed to your real market data, toggle a
type active/inactive, reorder, **Save categories**. The projector picks them up on next open.

## Common errors
| You see | Fix |
|---|---|
| "must be ≤ 100" on save | A percent field is over 100 — fix it |
| Save failed (permission) | You're not a true admin — rate config is admin-only |
| Projector didn't change | Reload the projector tab; it caches categories per open |
