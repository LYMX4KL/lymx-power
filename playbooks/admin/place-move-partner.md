---
slug: admin-place-move-partner
title: Place or move a partner under a sponsor (whole team moves)
project: LYMX Power
role: admin
prereqs:
  - admin_role
  - migration_171_admin_set_partner_sponsor
duration_min: 3
difficulty: easy
last_verified: 2026-05-31
related:
  - comp-plan-partner-walkthrough
  - commission-engine-verification
supersedes: null
---

# Place or move a partner under a sponsor

Every partner sits somewhere in the genealogy tree — they have a **sponsor** (their upline), and that placement is what decides who earns override commissions on their activity. Normally a partner's sponsor is set automatically when they sign up through someone's referral link. This tool is for the cases where that didn't happen, or happened wrong:

- A partner joined but their invite link wasn't used, so they have **no sponsor** and need to be placed.
- A partner ended up under the wrong upline and, after verifying their claim, needs to be **moved** to the correct sponsor.

**The key rule:** when you move a partner, their **entire downline moves with them**. They take their whole team. You only ever set the sponsor of the one partner at the top of the team you're moving — everyone beneath them stays attached and rides along.

## Who can do this

Admins only (Helen, Kenny). The button calls a permission-gated database function (`admin_set_partner_sponsor`), so a non-admin can't move anyone even if they reach the page.

## Step-by-step

1. **Open Partners** (sidebar → Admin → Partners, or `/admin-partners.html`).
2. Find the partner you want to place or move. Use the search box (name, email, or partner code).
3. The **Sponsor** column shows their current upline by partner code + name (or "—" if they have none yet).
4. Click the **⇅ Sponsor** button on that partner's row.
5. In the dialog:
   - **To place / change the sponsor:** start typing the new sponsor's **partner code** (e.g. `P-000001`) or their name, then pick them from the list.
   - **To remove the sponsor** (make this partner a top-of-tree root with no upline): check the box **"Remove sponsor — make this partner a top-of-tree root."**
6. Click **Save**.
7. You'll see a confirmation toast — including **how many downline members moved with them** — and the list refreshes with the new sponsor shown.

## What happens under the hood

- Only the selected partner's sponsor link changes. Their team's internal links are untouched, so the whole subtree moves intact.
- The genealogy tree (`mgc_tree`) is rebuilt automatically for the moved partner **and every member of their downline**, so override-commission eligibility is correct immediately — no separate cleanup step.
- The tool **blocks loops**: you can't make a partner their own sponsor, and you can't move a partner under one of their own downline members (that would create a circular team). If you try, you'll get a clear error and nothing changes.

## Good to know

- **It affects commissions.** Moving a partner changes who earns overrides on that whole team going forward. Confirm the partner's claim before you move them.
- **It's reversible** — just move them back the same way.
- **Placement vs. payout are separate.** This sets the tree. Actual payouts still run through the normal settlement flow.

## If something looks wrong

- *"No partner matches…"* — you typed a code/name that isn't in the list. Pick from the dropdown so the exact partner is selected.
- *"would create a loop in the genealogy"* — the sponsor you chose is somewhere inside the team you're moving. Pick a sponsor outside that team.
- *"Permission denied: admin only"* — you're not signed in as an admin. Only Helen/Kenny can move partners.
