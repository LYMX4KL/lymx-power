---
slug: admin-event-create
title: Create a new event end-to-end (admin + speakers + publish)
project: LYMX Power
role: admin
prereqs:
  - admin_role
  - migration_122_applied
  - storage_bucket_event_speakers_exists
duration_min: 15
difficulty: medium
last_verified: 2026-05-27
related:
  - admin-offer-accept-flow
supersedes: null
---

# Create a new event end-to-end

Generic event flow that backs the September 12 launch page (and any future events: town halls, partner mixers, anniversaries). The data lives in `public.events` + `public.event_speakers`. Public pages (like `/launch-event.html` for the launch row, and `/event-<slug>.html` for any other) read from these tables when the event is `status=published`.

## When you use this

- A new public event needs a microsite + RSVP-style coverage.
- You want a specific speaker lineup with bios, photos, and talks visible to the public.
- The previous hard-coded launch-event speakers need an update — speakers fill their own profile via magic link.

## What success looks like

By the end of this playbook:
- An `events` row exists with status='published'.
- Each speaker has a profile_complete or published `event_speakers` row.
- The public page renders the event details + each published speaker's photo + bio + talk.

## Steps

### Step 1 — Create the event shell

**Where:** `/admin-events.html`
**Do:** Click `+ New event` in the top-right. Fill the modal:
- Title (e.g. "LYMX Anniversary · One Year Later")
- Slug (auto-derived from the title — must be unique, letters/digits/hyphens only)
- Subtitle (one-liner shown under the title on the public page)
- Date + time (datetime-local input)
- Optional end time
- Location name + address
- Optional capacity

Click **Create event**.
**Expect:** Page redirects to `/admin-event-edit.html?id=<uuid>` with status='draft'.

### Step 2 — Fill in the long description

**Where:** `/admin-event-edit.html?id=<uuid>` (you should already be here from Step 1)
**Do:** Fill the **Description** textarea (markdown ok — supports `**bold**`, `[links](url)`, etc.).
Click **Save event details**.
**Expect:** Banner reads "Event details saved."

### Step 3 — Invite each speaker via magic link

**Where:** same page, **Speakers** section
**Do:** Click **+ Invite speaker**. In the modal:
- Display name (placeholder until they fill the profile — but Helen still types it so the queue looks meaningful)
- Title (optional placeholder)
- Invite email — where you'll send the magic link

Click **Generate magic link**.
**Expect:** A magic-link URL appears in the modal (e.g. `https://getlymx.com/event-speaker-edit.html?t=<uuid>`). Copy it — that's the URL you paste into your invitation email.

**Repeat** for each speaker. The token is one-time-use after the speaker submits, but the magic link itself can be re-copied as long as the token hasn't been used.

### Step 4 — Speaker fills their profile

**Where:** Speaker opens the magic link in their browser (no sign-in needed)
**They see:** A page with the event header + a form for name / title / company / bio / talk title / talk description / photo upload.
**They do:** Fill the fields, upload a JPG/PNG/WebP photo (under 5 MB), click **Save profile**.
**Expect:** Their `event_speakers` row flips to `status='profile_complete'`. The token is cleared (one-time-use). Their photo lands in Storage at `event-speakers/<event_slug>/<speaker_id>.jpg`.

If they need to update before publish: you can re-issue a magic link by adding them again as a new speaker row OR by extending an existing one. (V1 doesn't have a re-issue button — that's roadmap.)

### Step 5 — Review and publish each speaker

**Where:** back on `/admin-event-edit.html?id=<uuid>` (refresh)
**Do:** Each `profile_complete` speaker row shows a green **Publish** button. Click it to flip their `status` to `published` — that makes them visible on the public page.
**If they messed up:** delete the row, generate a fresh invite. Or use the **Unpublish** button later to hide them without deleting.

### Step 6 — Publish the event itself

**Where:** same page, top action row
**Do:** Click **Publish (make live)**. Confirm in the dialog.
**Expect:**
- `events.status='published'`, `published_at = now()`.
- The "🟢 Live at /event-<slug>.html" link appears in the action row.
- For the special slug `lymx-launch-25`, the existing `/launch-event.html` page picks up the data automatically (its JS reads from `events` + `event_speakers` matching that slug).

### Step 7 — Share the public URL

**Where:** anywhere you publish links (email, social, sidebar)
**Do:** Copy `https://getlymx.com/event-<slug>.html` (or `/launch-event.html` for the launch row).
**Expect:** The page renders the event details + all published speakers' real photos + bios + talks.

## Common errors

| What you see | Why | Fix |
|---|---|---|
| "Create failed: 23505 …slug…" | Slug already in use | Pick a different slug; slugs are unique. |
| Speaker photo upload "Upload failed: 403" | The `event-speakers` Storage bucket doesn't allow public INSERT | Supabase Dashboard → Storage → event-speakers → Policies → add an INSERT policy for `anon` with no restriction, or for `authenticated`. Migration 122 attempts to create the bucket but RLS on `storage.objects` is separate. |
| Speaker page shows "This link is invalid or has already been used" | Token was already submitted | Re-invite them on the admin page; that issues a new token. |
| Speaker page shows "This link expired" | More than 30 days since invite issued | Re-invite. |
| Public event page shows "404" | Event is still draft, OR slug typo in URL | Verify event is `status='published'` in the admin page. |
| Public page shows old hardcoded speakers | Migration 122 not applied, or no published speakers exist yet | Apply migration 122 (paste from `LYMX Backend/migrations/122_events_and_speakers.sql`). Verify with `SELECT * FROM events WHERE slug='lymx-launch-25'`. |

## What's NOT in v1

- **Auto-send invite emails** — Helen pastes the magic link into her own email manually. (Auto-email path is blocked by the same SES env bug that affects broadcasts.)
- **Per-speaker re-issue** — to re-invite a speaker whose token expired, delete + add again. A "re-issue magic link" button is roadmap.
- **RSVP collection on the public event page** — there's a separate form (`/admin-launch-rsvps.html` reads them) but it's only wired for the launch event. Other events would need extension.
- **Multi-event mass invites** — each event manages its own speakers; we don't have a cross-event speaker pool.

## Data sources

- **`public.events`** — table (migration 122)
- **`public.event_speakers`** — table (migration 122)
- **`fn_event_speaker_resolve_by_token(uuid)`** — public security-definer RPC
- **`fn_event_speaker_save_by_token(uuid, text…)`** — public security-definer RPC
- **`event-speakers`** — Storage bucket (public-readable; INSERT policy required for the upload from the magic-link page)

## Files involved

- `admin-events.html` (list)
- `admin-event-edit.html` (per-event details + speakers)
- `event-speaker-edit.html` (public magic-link)
- `launch-event.html` (refactored to read DB for slug='lymx-launch-25'; falls back to hardcoded cards if migration not applied)
- Generic `event-<slug>.html` template — **not built in v1**. For now, the only auto-rendered public page is `launch-event.html`. Future iteration: ship a generic event template that resolves the slug from the URL.
