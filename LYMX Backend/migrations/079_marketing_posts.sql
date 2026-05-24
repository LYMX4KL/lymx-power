-- =============================================================================
-- Migration 079 — Marketing posts (content hub)
-- =============================================================================
-- Added 2026-05-24 to power the Content Hub sidebar entry for customers,
-- partners, and businesses. Each post is a short, pain-point-focused
-- snippet with a CTA URL that carries the sharer's ref code so attribution
-- flows back to them (their referral becomes their down-stream
-- customer/partner/business).
--
-- The cta_url_template uses {REF} as the placeholder; the frontend swaps
-- it for the signed-in user's partner_code at render time. Customers
-- without a partner_code still get an attribution token (their U-code).
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.marketing_posts (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    audience          text NOT NULL,
    kind              text NOT NULL,
    pain_point        text,
    title             text NOT NULL,
    body_short        text NOT NULL,
    body_long         text,
    cta_label         text NOT NULL DEFAULT 'Learn more',
    cta_url_template  text NOT NULL,
    image_url         text,
    order_index       int  NOT NULL DEFAULT 100,
    published         boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketing_posts_audience_kind_idx ON public.marketing_posts(audience, kind, order_index) WHERE published = true;

ALTER TABLE public.marketing_posts DROP CONSTRAINT IF EXISTS marketing_posts_audience_known;
ALTER TABLE public.marketing_posts ADD  CONSTRAINT marketing_posts_audience_known
    CHECK (audience IN ('customer', 'partner', 'business', 'all'));

ALTER TABLE public.marketing_posts DROP CONSTRAINT IF EXISTS marketing_posts_kind_known;
ALTER TABLE public.marketing_posts ADD  CONSTRAINT marketing_posts_kind_known
    CHECK (kind IN ('social_short', 'social_long', 'sms', 'email_subject_body', 'caption', 'story'));

ALTER TABLE public.marketing_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marketing_posts_public_read ON public.marketing_posts;
DROP POLICY IF EXISTS marketing_posts_admin_write ON public.marketing_posts;

-- Any signed-in user can read published posts (the Content Hub is open
-- to all roles so anyone can grab a snippet to share).
CREATE POLICY marketing_posts_public_read ON public.marketing_posts
    FOR SELECT USING (published = true OR public.am_i_admin());

-- Admin can manage posts.
CREATE POLICY marketing_posts_admin_write ON public.marketing_posts
    FOR ALL USING (public.am_i_admin()) WITH CHECK (public.am_i_admin());

-- ─── Seed content ──────────────────────────────────────────────────────────
-- 18 starter posts, 6 per audience. Each has one focused pain point.
-- {REF} is substituted client-side with the sharer's partner_code or U-code.

INSERT INTO public.marketing_posts (audience, kind, pain_point, title, body_short, body_long, cta_label, cta_url_template, order_index) VALUES

-- ━━━ CUSTOMERS ━━━
('customer','social_short','rewards_fragmented',
 'Tired of carrying 12 different rewards cards?',
 'One wallet. Earn at every local business that joins. Spend rewards anywhere on the network.',
 'You collect points at the cafe. Different points at the gym. Different points at the gas station. None of them talk to each other and most expire before you redeem. LYMX is one wallet that earns and spends across every local business that joins. No cards. No app per shop. Just one balance you actually use.',
 'Start earning (free)',
 'https://getlymx.com/welcome.html?ref={REF}',
 10),

('customer','social_short','small_business',
 '5% back at your favourite local shop — pick the businesses, not the chains.',
 'Earn LYMX at your local cafe, gym, salon, and restaurant. Skip the megachains.',
 'Most rewards programs only work at big chains. LYMX is the opposite — it rewards you for spending at your local independents. The cafe you walk to every morning. The gym you actually use. The salon that knows your name.',
 'Find local businesses',
 'https://getlymx.com/browse?ref={REF}',
 20),

('customer','sms','signup_bonus',
 'SMS: 100 LYMX welcome bonus',
 'Hey — joining LYMX through my link gets you 100 LYMX free. Earn at local cafes / restaurants / salons / gyms. Quick signup: https://getlymx.com/welcome.html?ref={REF}',
 NULL,
 'Copy SMS',
 'https://getlymx.com/welcome.html?ref={REF}',
 30),

('customer','social_short','refer_bonus',
 'Tell a friend → you both get 100 LYMX',
 'Every friend who joins LYMX with your link credits 100 LYMX to your wallet AND 100 to theirs.',
 'Most refer-a-friend programs pay the inviter or the joiner, not both. LYMX pays both sides. Your link, your friends, two new rewards balances — and it stacks: refer 10 friends, you''re up 1,000 LYMX before you''ve spent a dollar.',
 'Grab my referral link',
 'https://getlymx.com/refer.html?ref={REF}',
 40),

('customer','email_subject_body','first_purchase',
 'Email: Your first LYMX purchase earns 5x',
 'Subject: Earn 5x LYMX on your first purchase at a LYMX business
\nThanks for joining LYMX. Pick any LYMX business in the network and your first purchase earns 5x the normal rate. Use it however you want — the cafe, the gym, the salon — and the rewards land in your wallet automatically. https://getlymx.com/browse?ref={REF}',
 NULL,
 'Copy email',
 'https://getlymx.com/browse?ref={REF}',
 50),

('customer','social_short','earnable_spending',
 'Your $5 latte is now $5 + 25 LYMX back.',
 'Every dollar you spend at a LYMX business adds to one rewards balance. No expiration, no card to forget.',
 'LYMX changes the math on every local dollar you spend. The latte is still $5, but now you walk away with 25 LYMX in your wallet — redeemable at any business in the network. It''s like cashback that you actually want to use, because you can spend it anywhere local.',
 'Get the wallet',
 'https://getlymx.com/welcome.html?ref={REF}',
 60),

-- ━━━ PARTNERS ━━━
('partner','social_short','side_income',
 'Bring local businesses onto LYMX → earn $500 per activation + 9% recurring.',
 'Founding 25 partners earn $750 per sign-up + 11% override + a permanent seat on the council.',
 'LYMX partners introduce local businesses to the network. Each business that signs up pays a $850 setup + $199/mo, and partners get $500 of every activation (Founding 25: $750), plus 9% of that business''s monthly fee for the life of the account (Founding 25: 11% override). No inventory. No service hours. Just relationships you already have.',
 'Apply to partner',
 'https://getlymx.com/partner-signup.html?ref={REF}',
 10),

('partner','social_short','founding_25',
 'Only 25 Founding Partner spots. After that the bonus drops $250.',
 'Founding 25 = $750/activation forever. Once filled, never offered again.',
 'After we close Founding 25, every new partner gets $500/activation and 9% override. Founding 25 partners keep $750/activation and 11% override permanently. You qualify by signing up your first 5 local businesses. We''re currently at lock-in — five business activations between you and a lifetime rate.',
 'See your tree progress',
 'https://getlymx.com/rep-dashboard.html?ref={REF}',
 20),

('partner','sms','recruit_a_partner',
 'SMS: Recruit another partner (downline)',
 'Hey — I''m on LYMX. I get paid $500 per local business activation. They pay $750 to Founding 25. Spots are open through end of week. Want me to walk you through it? https://getlymx.com/partner-signup.html?ref={REF}',
 NULL,
 'Copy SMS',
 'https://getlymx.com/partner-signup.html?ref={REF}',
 30),

('partner','social_short','no_inventory',
 'Income from local businesses you already know. No inventory, no shifts.',
 'LYMX partners just make introductions. We close, onboard, and bill. You collect.',
 'If you''ve ever wanted recurring income from your network without becoming a salesperson — LYMX is the cleanest version we''ve seen. We bring the deal mechanics: the contract, the dashboard, the onboarding, the customer support. You bring the trust. Every introduction that closes pays.',
 'Become a partner',
 'https://getlymx.com/partner-signup.html?ref={REF}',
 40),

('partner','social_long','three_generations',
 '3 generations of override income (not just 1)',
 'You earn 11% on direct activations + 4% on your recruits'' deals + 2% on their recruits'' deals.',
 'A flat 11% on the businesses YOU sign up is good. A 3-generation override is what builds real recurring income — when your partners sign up partners who sign up partners, you earn on all three layers. We cap it at three (no infinite MLM chains) so the math stays clean and the platform stays fair.',
 'See the comp plan',
 'https://getlymx.com/partner-vs-mlm.html?ref={REF}',
 50),

('partner','email_subject_body','recruit_business',
 'Email: Recruit a business owner you know',
 'Subject: A $850 / 3-mo free thing your business should look at
\nHi [Name], I''m working with LYMX, a loyalty rewards network that lets you reward customers in a way they can use at every other local business in the network. Setup is $850 with 3 months free; after that it''s $199/mo. Founding 25 businesses get a permanent feature spot on the LYMX homepage. https://getlymx.com/biz-signup.html?ref={REF}',
 NULL,
 'Copy email',
 'https://getlymx.com/biz-signup.html?ref={REF}',
 60),

-- ━━━ BUSINESSES ━━━
('business','social_short','foot_traffic',
 'Stop renting customers from Yelp. Own them with LYMX.',
 '5% LYMX per dollar = customers come back. AND every other LYMX business funnels customers your way.',
 'Yelp, Groupon, DoorDash — every platform takes a customer who walked in once and rents them back to you next month. LYMX flips that: every customer who joins through your shop becomes a network customer who shows up at YOU when they want to spend their LYMX. Plus every other LYMX business pushes their customers in your direction whenever LYMX is the redemption point.',
 'List my business',
 'https://getlymx.com/biz-signup.html?ref={REF}',
 10),

('business','social_short','founding_homepage',
 'Founding 25 businesses get a permanent spot on the LYMX homepage.',
 'After Founding 25 closes, homepage spots become paid placements. Founding 25 = permanent free.',
 'When LYMX launches publicly, the homepage features the Founding 25 — by name, by category, by location. Permanent. No re-application, no quarterly rotation. After Founding 25, homepage placements become paid promo slots ($200-500/mo). The 25 spots cost you the standard $850 setup + 3-months-free trial. You won''t see this offer again.',
 'Apply (3 months free)',
 'https://getlymx.com/biz-signup.html?ref={REF}',
 20),

('business','sms','quick_pitch',
 'SMS: Quick pitch to a business owner',
 'Hey [Name] — I''m onboarding local businesses to LYMX, a shared rewards network. Customers earn at your shop, spend at every other LYMX business and vice versa. $850 + 3 months free. Founding 25 spots have a permanent homepage feature. Worth 5 minutes? https://getlymx.com/biz-signup.html?ref={REF}',
 NULL,
 'Copy SMS',
 'https://getlymx.com/biz-signup.html?ref={REF}',
 30),

('business','social_short','customer_data',
 'You finally own your customer list (not Square, not Toast).',
 'LYMX gives you customer-level data on every transaction — yours to keep, yours to email, yours to win back.',
 'Most POS systems sell you the receipts and keep the customer data. With LYMX, every transaction is tied to a real customer profile YOU can read, segment, and message. No more "we don''t share that with our merchants" emails when you ask for your list back.',
 'See how it works',
 'https://getlymx.com/biz-marketing-kit.html?ref={REF}',
 40),

('business','email_subject_body','retention',
 'Email: Why your repeat rate is the only metric that matters',
 'Subject: 5x LYMX on first purchase = 38% higher repeat visits (network data)
\nWhen a customer''s first LYMX purchase at a new business earns 5x, the data we''re seeing across the network is a 38% lift in 30-day repeat visits — because the customer arrives at visit #2 already holding a balance they want to spend. The math is in the LYMX founder blog if you want the receipts: https://getlymx.com/founder-blog?ref={REF}',
 NULL,
 'Copy email',
 'https://getlymx.com/founder-blog?ref={REF}',
 50),

('business','social_short','no_marketing_budget',
 'Marketing budget = zero? LYMX is your marketing.',
 'Every LYMX customer in the network is a potential walk-in. You don''t pay for the audience.',
 'Local marketing is brutal — ad costs are up, customer acquisition is up, and every dollar competes with a chain''s deeper pockets. LYMX flips the cost: the LYMX network IS the audience. Customers earn at one local business and spend at any other. Your "marketing" is being on the map. That''s the whole pitch.',
 'List my business',
 'https://getlymx.com/biz-signup.html?ref={REF}',
 60);

COMMIT;
