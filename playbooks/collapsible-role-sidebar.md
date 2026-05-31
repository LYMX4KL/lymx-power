# Playbook — Collapsible role-group sidebar (no mode switching)

**What changed (2026-05-31):** the left sidebar no longer swaps its whole menu based
on which page you're on. Instead it shows **every section you have access to as a
collapsible group**, so your tabs stop moving around.

## What you'll see
- Groups at the top by role you hold: **Admin**, **Partner**, **Business**, **Customer**
  (you only see the ones you're entitled to; an admin sees all).
- The group for the page you're currently on is **expanded**; the others are collapsed.
- Click any group header (with the ▸ chevron) to expand/collapse it. You can have
  several open at once — open Admin *and* Partner if you want.
- One **Account** block stays at the bottom always: Profile, Messages, Notifications,
  My Feedback, Sign out. These no longer repeat inside every group.
- No more "viewing X mode" pill — there are no modes to switch between.

## Why
A user who is admin + partner + customer used to get a different menu on every page,
which made tabs impossible to locate ("sidebar very confusing"). Stable, collapsible
groups fix that.

## For developers
See ARCHITECTURE-RULES **Rule 10** and **Module 13**
(`14-Project Modules/13-collapsible-role-sidebar`). Implementation: `lymx-sidebar.js`
— `buildSidebar()` computes the entitlement ceiling (`max(path role, cached DB role)`),
renders a `.lymx-sb-grp` per entitled role (excluding `SHARED` hrefs), then one Account
block; group headers toggle `.open` independently. To add a page to a role's menu, add it
to that role's array in `MENUS`. To make an item shared, add its href to `SHARED`.
