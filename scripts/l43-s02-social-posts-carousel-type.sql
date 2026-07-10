-- l43-s02 — social_posts.post_type gains 'carousel' (applied live 2026-07-10).
-- The carousel producer dedupes on post_type='carousel' and the CHECK
-- constraint predates the format — caught by the live contract test (the
-- insert failed 23514 before any production run could). Same test then
-- verified the WHOLE last leg live: draft carousel with a calendar slot →
-- approval-shaped update (status→scheduled, approved) → the publisher's
-- exact pickup predicate returns it → cleaned to count==0.
ALTER TABLE social_posts DROP CONSTRAINT social_posts_post_type_check;
ALTER TABLE social_posts ADD CONSTRAINT social_posts_post_type_check CHECK (post_type = ANY (ARRAY['new_listing'::text, 'coming_soon'::text, 'open_house_announcement'::text, 'open_house_reminder'::text, 'price_reduction'::text, 'just_sold'::text, 'open_house_recap'::text, 'market_update'::text, 'custom'::text, 'carousel'::text]));
