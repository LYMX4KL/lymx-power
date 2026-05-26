---
slug: business-onboarding-02-signup
title: Sign up your business on LYMX (from an invite link)
project: LYMX Power
role: guest
prereqs:
  - has_invite_url
duration_min: 5
difficulty: easy
last_verified: 2026-05-26
related:
  - business-onboarding/01-invite
  - business-onboarding/README
supersedes: null
---

# Sign up your business on LYMX (from an invite link)

Step 2 of the business onboarding flow — the prospect's view. You've received a tracked invite link from someone at LYMX (Kenny, Rachel, Helen, or a LYMX Partner). Clicking the link opens the signup form with your name, email, and business name already filled in. You finish the remaining details and submit; LYMX admin reviews within one business day.

## What you'll need
- The invite URL from your email / text (looks like `https://getlymx.com/biz-signup.html?invite_token=...`)
- 5 minutes
- Basic business info: legal name, address (storefront) or service area (self-employed), EIN if you have one (you can leave it blank), and a password you'll use to sign in afterward

## What success looks like
You see a green "Application submitted" check on the page, and within one business day you get an approval email from `kenny@lymxpower.com` with a link to your dashboard + a calendar invite to a required 20-minute walkthrough with Rachel.

## Steps

### Step 1 — Open the invite link
**Where:** Your email (subject usually starts with your business name + "on LYMX"), or wherever the inviter sent the link.
**Do:** Click the **Set up [your business] on LYMX →** button OR paste the long URL into your browser.
**Expect:** The page at `getlymx.com/biz-signup.html` loads. At the top, a blue banner says: **"You were invited by [Kenny @ LYMX / a LYMX Partner]. We've pre-filled what we know — finish the form below to activate [your business name] on LYMX."**
**If you see a yellow warning banner instead** ("This invite link has expired / been revoked / already been used"): the link is stale. Reply to the original email asking for a fresh invite. You can still fill the form out manually below, but partner attribution may be lost.

### Step 2 — Pick your business type
**Where:** First card after the banner — "What kind of business are you?"
**Do:** Click **Storefront / Retail** if you have a physical location (café, restaurant, salon, gym, retail store). Click **Self-Employed Pro** if you're a freelancer / consultant / solo provider with no fixed storefront.
**Element:** `.kind-card` (one for each option — Storefront is selected by default)
**Expect:** The card you picked highlights with a blue border. The fields below change to match the type (Storefront shows a Location section; Self-Employed shows a Services section).

### Step 3 — Confirm the owner account fields
**Where:** "Owner account" section — second card on the page.
**Do:** Check that **Owner full name** and **Email** are pre-filled correctly. Add your **Phone** number if it isn't already. Create a **password** (10+ characters — this is what you'll use to sign in to your dashboard after approval).
**Element:** `[name=owner_name]`, `[name=owner_email]`, `[name=contact_phone]`, `[name=owner_password]`
**Expect:** The fields you change show your typed value. Password field shows dots (hidden).
**If owner name/email weren't pre-filled:** the invite didn't include them — fill in manually. This is normal for invites created without the prospect's contact info.

### Step 4 — Business identity
**Where:** "Business identity" section.
**Do:** Confirm **Legal business name** and **Display / trade name** (both usually pre-filled with the same name). Update one or both if your DBA differs from the legal entity. Pick a **Category** from the dropdown. Confirm the **Business contact email**.
**Expect:** No errors — these fields don't have strict validation beyond "not empty."

### Step 5 — Location (Storefront only)
**Where:** "Storefront location" section — only visible if you picked Storefront in step 2.
**Do:** Enter your **Location name** (e.g. "Downtown" or just the business name again), **Street address**, **City**, **State** (2-letter abbreviation like `NV`), and **ZIP**.
**Expect:** No specific validation; the address is informational at this stage.

### Step 5b — Services (Self-Employed only)
**Where:** "Services" section — only visible if you picked Self-Employed Pro.
**Do:** List at least one service: **Name** (e.g. "60-min consulting call"), **Price (USD)** if there is one, and **LYMX per booking** (how many LYMX the customer earns). Click **+ Add service** for more.
**Expect:** Each service row stays on the page. You need at least one row with a valid "LYMX per booking" value to submit.

### Step 6 — Legal / tax (optional)
**Where:** "Legal & tax info" section — the only required field here is EIN format-validation IF you enter one.
**Do:** Skip if you'd rather provide these during the Rachel walkthrough. If you enter an **EIN**, it must be in the format `NN-NNNNNNN`. **Year founded** must be between 1700 and next year.
**Expect:** You can leave the whole section blank and still submit.

### Step 7 — Operating hours (optional)
**Where:** "Hours" section.
**Do:** Pick open + close times for each weekday, or tick **Closed** for days you're closed. Skip the whole thing if you'd rather configure this later in your dashboard.
**Expect:** Skipped hours just save as "unset" and you can edit them after approval.

### Step 8 — Accept terms + submit
**Where:** Bottom of the form.
**Do:** Tick the checkbox **"I'm authorized to sign on behalf of the business and I accept the Business Terms and Privacy Policy."** Click **Submit application**.
**Element:** `#tos` checkbox, `#submit` button
**Expect:** Button changes to "Submitting…" briefly, then the form is replaced with a green check + the text **"Application submitted"** and "You'll get an approval email within 1 business day." Scroll down to see a link to optionally **Book a 1-on-1 onboarding call** with Rachel.

### Step 9 — Wait for approval
**Where:** Your email inbox (the address you used in step 3).
**Do:** Watch for an email from `kenny@lymxpower.com` with the subject **"Your LYMX Business is live — [your business name]"** (approved) or one explaining why we couldn't approve this round (rejected).
**Expect:** Most applications get reviewed within one business day. The approval email includes:
- A link to your business dashboard
- A link to your customer landing page (`getlymx.com/welcome.html?biz=<your-slug>`)
- Instructions to book your required 20-minute walkthrough with Rachel
**If you don't see the email within 24 hours:** check your spam folder. Add `kenny@lymxpower.com` to your contacts. If it's still missing after 48 hours, reply to the original invite email.

## Common errors

| Error / what you see | What it means | Fix |
|---|---|---|
| Yellow banner: "This invite link has expired" | The default 30-day lifetime ran out. | Ask whoever sent the invite for a new one — they can revoke and re-issue. |
| Yellow banner: "This invite link has been revoked" | The inviter pulled it back. | Reach out to the inviter directly. |
| Yellow banner: "already been used" | Someone (you or another account) finished signup with this link. | Sign in to the existing account — don't create a duplicate. |
| Red banner: "Password must be at least 10 characters" | The password you typed is too short. | Use a longer password. |
| Red banner: "EIN must be in the format NN-NNNNNNN" | Your EIN doesn't match the U.S. federal format. | Either leave EIN blank or fix the format. |
| Red banner: "Website must start with http:// or https://" | You wrote a domain without the scheme. | Add `https://` in front. |
| Form just won't submit when you click | The TOS checkbox isn't ticked. | Tick the "I'm authorized" checkbox at the bottom. |
| You see "Sign-up failed (400)" or "(500)" | Backend rejected the payload. | Take a screenshot and email it to `hello@getlymx.com` — usually a validation edge case we'll fix on our side. |
| You typed an email that already has a LYMX account | A previous signup attempt used the same email. | Use a different email or sign in to the existing account first. |

## Who can do this
- Anyone with a valid invite URL — you don't need an existing LYMX account.
- The form also works WITHOUT an invite URL (open `https://getlymx.com/biz-signup.html` directly), but you lose the partner attribution + pre-fill benefits.

## Reference / under the hood

For technical readers — skip if you're a non-developer.

**Frontend (biz-signup.html, migration 093):**
- On page load, an async IIFE reads `?invite_token=` from the URL.
- It calls `fn_validate_invitation_token(p_token)` via PostgREST. This is a `SECURITY DEFINER` Postgres function — anon can call it without RLS friction.
- On the first call for a given token, the function sets `biz_invitations.clicked_at = now()` and flips status from `pending` → `clicked`.
- The return shape includes `valid` (bool), `reason` (text — `ok` / `expired` / `revoked` / `already_used` / `not_found` / `malformed_token`), and the prospect fields (`prospect_business_name`, `prospect_owner_name`, `prospect_contact_email`, `prospect_contact_phone`, `has_partner` bool).
- If `valid === true`: the IIFE stashes the token on `window.__LYMX_INVITE_TOKEN`, shows the blue banner with inviter label, and prefills six form fields (`owner_name`, `owner_email`, `contact_email`, `contact_phone`, `display_name`, `legal_name`) — but only if those fields are currently empty.
- If `valid === false`: it shows the yellow banner with a friendly reason and lets the user fill the form manually.

**Submission path:**
- The form submit handler adds `invite_token: window.__LYMX_INVITE_TOKEN` to the payload.
- The `business-signup` Edge Function (service-role) receives the token, creates the auth user + businesses row + (storefront) location or (self-employed) services, and at the end calls `fn_link_invitation_to_business(p_token, p_business_id)`.
- That RPC sets `biz_invitations.status = 'signed_up'`, `signup_completed_at = now()`, `resulting_business_id = <new biz>`. If the invite had `assigned_partner_id`, it also writes `businesses.signed_up_by_partner_id` so commission attribution flows through migration 035's approval trigger.

**The invite token has no side effect on signup payload validation.** The form works identically with or without the token; the token just controls prefill + attribution.

**Privacy:**
- The token validation never returns the inviter's identity beyond a `has_partner` boolean. The blue banner says either "the LYMX team" or "a LYMX Partner" — never names.
- The token itself is 256 bits of URL-safe random; brute-force enumeration is infeasible.
