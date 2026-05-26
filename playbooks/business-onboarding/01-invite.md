---
slug: business-onboarding-01-invite
title: Invite a business to LYMX
project: LYMX Power
role: admin                       # also usable by partner — see "Who can do this"
prereqs:
  - signed_in_as_admin_or_partner
duration_min: 3
difficulty: easy
last_verified: 2026-05-26
related:
  - business-onboarding/README
supersedes: null
---

# Invite a business to LYMX

Send a prospect a tracked invitation link. The link opens our standard signup form with their name + email already filled in, and tells the system who invited them so the right partner gets attribution if it converts. Replaces the old "paste the signup URL into an email by hand" workflow that left no audit trail.

## What you'll need
- An admin account (Kenny / Helen / any staff with admin role) OR a partner account
- The prospect's business name (required)
- Optionally: the owner's name, email, phone, and any notes you want to remember

## What success looks like
The invite appears in your Invites list with status "pending." If you checked "Email the link," the prospect receives an email from `kenny@lymxpower.com` with a personalized button. When they click it, the status flips to "clicked." When they submit the signup form, status flips to "signed_up" and the resulting business row links back to your invite for attribution.

## Steps

### Step 1 — Open the right page
**Where:**
- **Admin:** open `https://getlymx.com/admin-business-applications.html` (sidebar → Admin → Business applications)
- **Partner:** open `https://getlymx.com/partner-crm.html` (sidebar → Partner → My prospects)

**Do:** Sign in if you haven't already.
**Expect:** You see your application queue (admin) or prospect CRM (partner).

### Step 2 — Click "Invite a business"
**Where:** Top-right of the page
**Do:** Click the blue **+ Invite a business** button (admin) OR the ghost **📨 Invite via LYMX** button (partner). They open the same modal.
**Element:** `#btnInviteBiz` (admin) · `#btn-invite-biz` (partner)
**Expect:** A modal slides in titled "Invite a business" / "Invite a business to LYMX."

### Step 3 — Fill in what you know
**Where:** The Invite modal
**Do:** Type the prospect's:
1. **Business name** (required, min 2 chars)
2. **Owner name** (optional but very helpful — it shows up on the email greeting and the signup form's pre-fill)
3. **Contact email** (optional but required if you want the system to email the link)
4. **Contact phone** (optional, lands on the signup form's pre-fill)
5. **Notes** (optional, only you + admins see this — useful for "met at chamber breakfast, mentions seasonal cash flow concerns")

Leave the **"Email the invite link to the contact email"** checkbox ticked if you want the system to send the email itself. Untick it if you'd rather copy the link manually and send it via WhatsApp / text / your own template.

**Expect:** No errors as you type (the only required field is Business name).

### Step 4 — Click "Create invite"
**Where:** Bottom right of the modal
**Do:** Click **Create invite**.
**Element:** `#inviteSubmit`
**Expect:**
- A green success card appears inside the modal showing the invite URL.
- If the prospect's email was filled in AND the "email" checkbox was ticked: the card also says "+ email sent ✓".
- The form clears so you can immediately create another.

### Step 5 — Send the link (manual path)
**Where:** The green success card inside the modal
**Do:** Click **Copy URL**, then paste it into your own message — text, DM, calendar invite, whatever.
**Expect:** "Copied." toast at the bottom.

### Step 6 — Watch the status
**Where:** The Invites tab (admin) or Invites section (partner)
**Do:** Close the modal. Click the **Invites** tab on the admin page (the counter shows how many are pending). Each invite card shows:
- Status badge: `pending` → `clicked` → `signed_up`
- Created / Expires / Clicked / Signed-up timestamps
- If a partner created it: their name
- If the prospect signed up: a link to the resulting business

**Expect:** Refresh the page (or click between tabs) to see status changes. The system marks `clicked` the first time the prospect opens the link.

### Step 7 — Resend or revoke if needed
**Where:** Each invite card has an actions row at the bottom
**Do:**
- **Resend email** — sends the same link to the same email again. Useful when a prospect's inbox ate the first send.
- **Revoke** — kills the link so it can no longer be used. Useful when you sent to the wrong person, or the prospect asked to be removed.

**Expect:** A toast confirms each action. Revoked invites stay visible (for audit) but the link itself stops working.

## Who can do this
- **Admin:** can create invites for any prospect, with or without partner attribution.
- **Partner:** can create invites — the system automatically attaches their partner attribution so commission flows correctly when the business activates.

## Common errors

| Error | What it means | Fix |
|---|---|---|
| `Business name is required` | You left the Business name field empty | Fill in at least 2 characters in Business name. |
| `Only admins and partners can create invitations` | You're signed in as a customer or anonymous | Switch to an admin or partner account. |
| `Email the invite link to the contact email` ticked but no email field | You can't email without an address | Either fill in Contact email or untick the box. |
| Email shows up in their spam folder | First contact from a new sender often does | Tell them to look in spam + add `kenny@lymxpower.com` to contacts. Or send the link via text instead. |
| Prospect's link says "expired" | Default lifetime is 30 days from creation | Create a new invite — the old token can't be reused even via the same flow. |
| Prospect's link says "already used" | They (or someone else) signed up through this link already | Look at the Invites tab — the card for that invite will link to the resulting business. If the wrong account signed up, contact Kenny to merge / clean up. |

## Reference / under the hood

For technical readers — skip this section if you're a non-developer.

**Schema (migration 093):**
- `public.biz_invitations` — one row per invite. Includes `invitation_token` (URL-safe random), prospect contact fields, `invited_by_user_id`, `assigned_partner_id`, `expires_at` (default +30d), `clicked_at`, `signup_completed_at`, `resulting_business_id`, `status` enum (`pending` | `clicked` | `signed_up` | `expired` | `revoked`).
- `public.v_admin_biz_invitations` — RLS-aware view that joins partner + resulting-business names. The Invites tab queries this.

**Edge Functions:**
- `biz-invite-create` — admin or partner-authenticated. Generates a 256-bit URL-safe token, inserts the row, optionally chains into the email send.
- `biz-invite-send-email` — pulls the row, renders the invite template, sends via Resend with `kenny@lymxpower.com` as the from address. Records the send in the invite's `notes` column for "last emailed" visibility.

**Public RPC:**
- `fn_validate_invitation_token(p_token text)` — SECURITY DEFINER. Called by `biz-signup.html` on page load. Validates the token, marks `clicked_at` on first call, and returns prefill data (business name, owner name, email, phone) — but never the token or inviter PII. If the token is expired/revoked/already-used, returns `valid=false` with a `reason` field.

**Service-role RPC:**
- `fn_link_invitation_to_business(p_token text, p_business_id uuid)` — called by the `business-signup` EF immediately after the businesses row is created. Sets `resulting_business_id` + `signup_completed_at` + writes `businesses.signed_up_by_partner_id` if the invite had partner attribution, so commission flows through migration 035's approval trigger.

**RLS:**
- Admins: full CRUD via `am_i_admin()`.
- Partners: SELECT + UPDATE on rows where they are `assigned_partner_id` or `invited_by_user_id`. INSERT requires `invited_by_user_id = auth.uid()` and either no assigned_partner_id or one matching their own partners row.
- Anonymous: no direct table access. The only public surface is `fn_validate_invitation_token`.
