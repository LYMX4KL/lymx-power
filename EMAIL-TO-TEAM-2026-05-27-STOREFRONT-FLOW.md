# Email to Dave, Rachel, Helen — new business storefront flow shipped

**Subject:** New business storefront flow shipped — what each of you owns

**Audience:** Dave (partner), Rachel (partner concierge / onboarding), Helen (admin / approvals)

**Send via:** in-app team broadcast OR plain email from Kenny's account.

---

Hi team,

Quick heads up — Phase 1 + Phase 2 of the auto-populated storefront just shipped. The old hand-coded per-business HTML files (`biz-oakline-kitchen.html`, `biz-brew-and-bean.html`) are gone. Every approved business now has a public storefront at `https://getlymx.com/biz?slug=<their-slug>` that pulls everything from data they manage themselves at `https://getlymx.com/biz-profile.html`.

This affects each of you differently. Read just your section.

## Helen (Admin / Approvals)

Nothing changes in your approval queue. Same admin-business-applications.html, same Approve / Request more info / Reject buttons. The moment you flip a row to `approved`, two things happen automatically:

1. The owner gets the welcome email (already auto-sent by the `business-approval-email` EF — now updated to also tell them where the storefront editor lives).
2. Their public storefront becomes reachable at `/biz?slug=<slug>`. No "publish" step needed.

If you want to peek at how their page looks before they fill it in, navigate to the URL directly — you'll see the emoji + tagline you can see in their application + "PREVIEW listing" banner if `demo_only` is set.

**One ask:** when you approve a real business (not demo_only), tell them in the approval notes that Rachel will reach out for the onboarding call. Helps Rachel hand-off.

## Rachel (Partner Concierge / Onboarding)

You're now the human walking owners through the storefront editor. The 20-min onboarding call is the canonical place where this happens. The welcome email points the owner straight at your booking link (`/book-onboarding-call.html?biz=<slug>`), and the email now also mentions you'll cover the storefront tour.

For the call itself, the playbook to walk them through is at `playbooks/business-operations/edit-my-storefront.md` — it's a checklist of the 5 tabs (Profile info / Hours / Photos / Offers / Menu) and what's behind each. Each tab also has its own deep-dive playbook:

- `business-operations/upload-photos.md`
- `business-operations/manage-offers.md`
- `business-operations/manage-menu.md`

You can read these directly, OR sign in as the biz owner (use the test account `demo+oaklinekitchen@lymxpower.com` if you need a sandbox), go to `/biz-profile.html`, and tap the **📖 Page guide** chip at the bottom-left. That opens the playbook inline.

**One ask:** when you finish the 20-min call, fire the in-app broadcast (admin-tech-support → broadcast-send) to all LYMX users within their ZIP code area saying "[Display Name] just joined LYMX — here's why" with a link to their storefront. The auto-blast pipeline is being built now (see Kenny's E task below); for the next week or two, please send this manually after each call so the data shows whether the local-blast feature is worth automating.

## Dave (Partner / Sales)

When you sign up a new business, the moment Helen approves it, your activation credit lands automatically (no change). What's new is what you can SHOW them on the demo:

- The public storefront (e.g. `https://getlymx.com/biz?slug=oakline-kitchen` as the proof-of-shape demo)
- The owner editor (`https://getlymx.com/biz-profile.html` after they sign in)
- They control their own page — photos, hours, offers, menu — no LYMX engineering bottleneck

If a prospect asks "can I customize my page?" the answer is yes, end-to-end, in the editor. If they ask "do I need to learn HTML?" the answer is no.

For your pitch deck, the two reference URLs to keep handy:
- `getlymx.com/biz?slug=oakline-kitchen` — fully populated demo (photos + offers + menu)
- `getlymx.com/biz?slug=brew-and-bean` — second demo, cafe variant

## What's still on the runway (FYI, not blocking you)

- **Auto-blast on approval** — when Helen approves a real business (not demo), the LYMX customers within their ZIP code get an email saying "your local merchant just joined." Phase 1 will be ZIP-prefix matching; geocoding + true-distance is Phase 2.
- **Home-page sections** — top 10 most-rated local + new businesses (rotating 30 days). Both shipping next.
- **Drag-to-reorder** on photos and menu items — current owner UX is delete + re-add. Phase 3 polish.

If anything breaks in the storefront editor or the public page, file via the in-app feedback widget — Kenny's on every ticket within a day.

— Kenny
