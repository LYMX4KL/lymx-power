# LYMX next-sprint build plan (audit of 88 deferred tickets)

> 2026-05-27 late-evening audit. Every open ticket was read end-to-end. Most "bugs" testers filed are surface symptoms of unbuilt features. Grouping them into 8 build sprints + 3 already-shipped verify-replies. Each sprint closes 5-15 related tickets so progress compounds.

## Already shipped — fire verify-replies first (3 tickets)

These were filed before today's ships landed. Sending resolved+verify replies in the morning clears them.

| Ticket | Summary | Where it landed |
|---|---|---|
| `026db35c` | Reserve a Table doesn't persist | Sprint 4 today (biz-reservations.html inbox + lymx-biz-actions submitReservation 2026-05-25) |
| `b37214f3` | Partner can't view recruited customers | Sprint 6 today (partner-my-customers.html) |
| `4aa8c795` / `1305b425` / `4636ed0c` | Clock-in button missing | Already exists on staff dashboard for `is_on_payroll=true`; check Sprint 12 if discoverability is the real complaint |

## Sprint 7 — Hydrate empty/wrong data feeds (~10 tickets)

**Goal:** every "Recent Activity / list / counter" surface reads from its real backing query. No more silent zeros, no more mismatched counts.

**Tickets closed:**
- `b679f887` Partner Dashboard Recent Activity empty
- `e5dd5d72` 3-Generation Tree empty
- `c4cbf47c` Customer Referral shows "Friend" instead of real names
- `fe74c743` Customer Wallet wrong activity for partner accounts
- `12486612` Customer History inaccurate data
- `62370c32` Customer Settings referral total wrong (200 vs 500 actual)
- `29eedbfd` Customer Dashboard says 77 messages but only 3 show
- `c23046a9` Submitted RSVP doesn't appear in list table
- `348abe95` Confirmed Bookings not in My Bookings page

**What to build:**
- One canonical `v_partner_recent_activity` view (last 50 events: commissions, downline activations, referrals)
- Fix `partner-tree` query to read from `partners.sponsor_partner_id` recursion (existing FK)
- Customer Referral page join to `auth.users.user_metadata->>'full_name'` or `customers.display_name` instead of hardcoded "Friend"
- Customer-wallet `Recent Activity` must role-aware: partners see their commissions, not customer earn/spend
- Audit every `count` badge against the actual query it pairs with — there's drift in 3+ places

**Estimated:** 1 session. Mostly migration + view work + 4-5 small page wires. Highest leverage because empty-state tickets are the testers' #1 frustration.

## Sprint 8 — Recruitment funnel + universal share (~14 tickets)

**Goal:** every share / invite / signup link path works end-to-end. Every page is shareable from a uniform button. New users land in the right funnel.

**Tickets closed:**
- `33513118` "Can't click sign up" on /welcome.html
- `5bc1c9ed` "Create Free Wallet Now" routes wrong on /browse
- `efde04e2` Generated invite link doesn't auto-populate referrer ID
- `eb909f5b` Biz signup "email already exists" (stale test data + better error message)
- `dcfb136f` Invite Friends "Add at least one valid email" stuck
- `d785fe0e` Invite Friends "Done — 0 sent, 1 failed HTTP 403"
- `b9b4a228` Feedback queued but never sent
- `c015b0ed` Pages need universal share button
- `da1d7396` "Open in App" shouldn't show when already in app
- `b78e5ae6` Share button on biz profile not working
- `48d7823f` Share buttons on share-hub cards not working
- `464e3e08` SMS button redirects to customer dashboard
- `37bb73c1` No dedicated page for managing recruitment links
- `cee93a28` "Share Your Recruiter Link" uses customer messaging
- `0fb8ab93` Dropdown overlay style on browse

**What to build:**
- New `partner-recruit-links.html` page that lists all 4 link templates (customer / partner / business / biz-invite) with copy + share buttons, all auto-stamped with the partner's `partner_code`
- Universal `lymx-share-button.js` module — drop a `<button data-lymx-share>` anywhere and it gets navigator.share + clipboard fallback + toast. Replace the page-specific implementations on biz-brew-and-bean and share-hub
- Fix `lymx-biz-actions.js` share handler conflict with inline shareBiz definitions
- Diagnose `admin-invite-friends` HTTP 403 — likely an EF auth check rejecting the admin role
- Welcome page sign-up button — investigate "can't click" (probably z-index / overlap on mobile)
- `cta_url_template` for SMS button — fix the role-aware routing
- Hide "Open in App" when user-agent is in-app webview

**Estimated:** 1-2 sessions. The universal share button is the highest leverage — it touches ~30 pages.

## Sprint 9 — Wire dead buttons + fix routing (~8 tickets)

**Goal:** every button does what its label promises. No more "button does nothing" or "button goes to wrong page."

**Tickets closed:**
- `d3171999` "Update Bank Info" routes to dashboard instead of bank form
- `6f374557` "Submit Event" opens email client instead of form
- `ad679378` Print Kit PDF/PNG buttons (need actual file generation pipeline)
- `745e5094` Save button on /browse doesn't save
- `4c006a71` Browse category filter doesn't update location
- `b4c4ffc1` Playbook link 404 (Gmail setup) — check partner-email-setup slug
- `74656f09` Auto-generated LYMX email alias can't be used for login
- `4b9926dc` Commission calc scenario cards no selected state

**What to build:**
- `partner-bank-update.html` — Stripe Connect bank update flow (or reuse existing biz-payouts pattern for partners)
- `/customer-vegas-events` — replace mailto: link with proper form posting to a `vegas_event_submissions` table
- `biz-print-kit` PDF/PNG generation — either jsPDF in-browser or an EF that renders to PDF; this is real work
- Save button on /browse — bug in `lymx-biz-actions.js` save wiring (probably wrong selector or RLS denial)
- Browse category filter — wire the geo/category combination properly
- Investigate playbook 404 — `partner-email-setup` is in INDEX.md per the earlier audit; likely a path-resolution bug
- Login resolver — extend `resolve-login-identifier` EF to include the auto-generated LYMX alias

**Estimated:** 1-2 sessions. Print Kit PDF generation is the biggest unknown.

## Sprint 10 — Responsive + universal layout pass (~12 tickets)

**Goal:** consistent header / nav / layout across every page, on every viewport. No squeeze, no overlap, no missing tabs.

**Tickets closed:**
- `d6420793` Partners dashboard mobile layout shifts
- `026a0602` Customer History squeezed
- `55dbbaaa` Customer Dispute squeezed
- `5b986813` Fixed-positioned components hide right-side content on biz pages
- `13241f81` LYMX History container misaligned
- `71c1c1eb` Header alignment on my-feedback
- `2691795d` Back button overlaps hamburger
- `ca58f57f` Help button overlaps Print button
- `d8c66097` Messages page no nav bar
- `87485d22` Notifications page tabs hidden
- `15430537` Header on /browse — buttons cramped + cut off
- `cf25d36c` Admin horizontal menu bar too long — dropdown instead
- `50cf8a8f` Book 30 min buttons look like tags, not buttons

**What to build:**
- Shared `<lymx-page-header>` module — used by every page; one source of truth for back-button + brand + role-tag + nav. Eliminates the per-page header drift that causes overlap bugs.
- Audit every `position:fixed` / `position:absolute` declaration on biz pages; replace with `position:sticky` or grid-based layouts
- Mobile breakpoints: ensure `/customer-history`, `/customer-dispute`, `/rep-dashboard` are usable at 360px wide
- Admin top nav → dropdown when > 6 items
- Notifications page — investigate the hidden-tabs bug (likely overflow:hidden somewhere)
- Help & Feedback button — universal z-index policy (it should never overlap content)

**Estimated:** 2 sessions. Shared header alone is a 1-session task; mobile pass is another.

## Sprint 11 — Content + copy editorial pass (~16 tickets)

**Goal:** one focused content-only session. No new features; just text + small icon swaps.

**Tickets closed:**
- `736c209d` "How it works" needs $750 + Founding 25 explanations
- `ed9ab6df` + `a5eb1a85` Green card on /business — "perspective shift" copy fix (DUP)
- `56fd10b7` "What Counts" section confusing
- `6c7907dd` Trust & Safety pill badge too wordy
- `f9ab2467` "Read it. Hold us to it." awkward
- `efdc492a` + `63174255` "FREE" repetition (DUP)
- `c74dd0a3` "+18 Average Coached" wording
- `ebc09512` "14 hr Average Response" disclaimer
- `43591cac` Business days clarification on /trust-and-safety
- `c00e425d` Grammar editing on /trust-and-safety
- `b1fa1cfd` Privacy Rights says optional but fields are required — make the policy match reality OR make the fields actually optional
- `5bcd6948` Add CTA below /business box
- `3488ce32` Customer signup row missing tag
- `27332f6f` Calendar icon shows random date
- `c842130c` Replace initials with real faces (needs photo assets from team)
- `e0676907` Blue text on /launch-event looks like a link
- `c9a4fa87` /what-is-lymx comparison table unclear
- `4b738066` Screenshot auto-capture — make optional
- `674d57fa` + `9001c0f1` Launch-event speaker profiles (DUP)
- `17ec1753` Waving hand emoji alignment

**What to build:** nothing. 90 minutes with the docx editor pattern + a careful read of each ticket. No code, just text. Could be done by you or a copywriter.

**Estimated:** 0.5 session. The bulk is decision-making, not implementation.

## Sprint 12 — Clock-in discoverability + HR/admin polish (~8 tickets)

**Goal:** the Clock-in flow that already exists in the database becomes findable and usable. HR onboarding playbook flow works end-to-end.

**Tickets closed:**
- `1305b425` Clock-in icon missing from dashboard
- `4636ed0c` Clock-in page can't be found
- `4aa8c795` Clock-in button missing
- `87244157` Can't find own feedback submissions
- `b39ad14a` HR onboarding playbook stuck — limited roles
- `7794aff9` Hiring page duplicate buttons + role limitation
- `ba57da24` Pending Verification fails

**What to build:**
- Persistent "Clock In" badge on every signed-in page header (when `is_on_payroll=true`), like the universal Sign In chip
- "My feedback" page — filter to `submitted_by = auth.uid()` by default with a toggle to see all
- Role enum expansion — add concierge / customer support / marketing / etc. to the hiring role options
- Investigate the verifications page 403/fail — possibly RLS on `verifications` table

**Estimated:** 1 session. Mostly small wires + a role enum migration.

## Sprint 13 — Avatar + profile-image pipeline (~3 tickets)

**Goal:** the avatar uploaded on /profile shows up everywhere a user is displayed.

**Tickets closed:**
- `d477405e` Profile sidebar doesn't display uploaded avatar
- `72e31cfb` My Reviews profile image not displayed
- `15430537` (partial) Header avatar consistency

**What to build:**
- Audit every place an avatar might render: sidebar header, my-reviews, my-conversations, profile cards on partner-tree, leaderboard
- Make sure every place reads from the same source (`profiles.avatar_url` or `auth.users.user_metadata->>'avatar_url'`)
- `lymx-nav.js` already has `paintAvatarOn` — extend it to every avatar slot

**Estimated:** half session.

## Already-built sidebar/notification follow-ups (do during another sprint)

These are Phase B items mentioned in today's ships that didn't need their own sprint:

- **Sidebar bell badge for partner unread count** — `fn_partner_unread_count` RPC exists; needs a JS hook in lymx-sidebar.js mounting (~10 min, do during Sprint 7)
- **Stripe execute side** of business settlement + donations payout — waits on Stripe Connect platform approval. Build `business-settlement-execute` + `donations-payout-run` EFs the day Stripe approves the platform
- **`admin-nonprofits.html`** registry CRUD — needed before adding more than Local Food Bank
- **`admin-notifications.html`** for manual partner system messages — feature key exists, page doesn't

## Suggested execution order

If you want to maximize ticket-close rate per hour: **Sprint 11 → Sprint 7 → Sprint 8 → Sprint 10 → Sprint 9 → Sprint 12 → Sprint 13**.

- Sprint 11 (content) is fastest and closes 16 tickets in half a session.
- Sprint 7 (data hydration) is highest user impact — empty dashboards = "this app is broken" perception.
- Sprint 8 (recruitment funnel) directly drives growth; you can't onboard new testers without these working.
- Sprint 10 (layout) closes the "why does it look weird" tickets that erode trust.
- Sprint 9 (dead buttons) is the longest individual sprint because Print Kit PDF generation is real engineering.
- Sprint 12 (clock-in / HR) is internal-team-only so lower external urgency.
- Sprint 13 (avatar) is polish — last.

## Tally

| Bucket | Tickets |
|---|---|
| Verify-replies (already shipped) | 3 |
| Sprint 7 — data feeds | 9 |
| Sprint 8 — recruitment + share | 15 |
| Sprint 9 — dead buttons | 8 |
| Sprint 10 — responsive + layout | 13 |
| Sprint 11 — content/copy | 20 (with dupes) |
| Sprint 12 — clock-in + HR | 7 |
| Sprint 13 — avatar | 3 |
| **Total addressable** | **~78** |

Remaining ~10 are edge questions that resolve themselves as the sprints above land (e.g., `18cecc2f` "is this the right email?" — answer it directly in conversation, no code needed).
