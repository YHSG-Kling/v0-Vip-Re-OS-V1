-- l43-s01 — the SOCIAL CAROUSEL SLIDE (applied live 2026-07-10).
-- The repurposer named `instagram_carousel` as an output format but never
-- produced a multi-image SET (caption-only stub). CarouselSlide: 1080x1350
-- (4:5 IG portrait) still, one per swipe — AI-planned copy (compliance-
-- gated, deterministic fact-built fallback), rendered through the still
-- rail (word-perfect text), assembled by the producer into ONE
-- approval-gated social_posts row with ordered media_urls. Produced
-- autonomously per marketing-window listing by runListingCarousels on the
-- daily video-plays cron (idempotent per listing). Registered static_card
-- (finish-spec: the set IS the deliverable).
INSERT INTO remotion_compositions (composition_id, display_name, category, orientation, width, height, duration_frames, fps, requires_did_avatar, requires_voiceover, tier_access, is_active, seo_title, seo_description, thumbnail_composition_id, supports_bookends)
VALUES ('CarouselSlide', 'Social Carousel Slide (4:5)', 'listing', 'static_card', 1080, 1350, 1, 30, false, false, ARRAY['platform','multi_location','brokerage','team'], true, 'Listing carousel', 'One swipe of a branded Instagram listing carousel.', NULL, false)
ON CONFLICT (composition_id) DO NOTHING;
