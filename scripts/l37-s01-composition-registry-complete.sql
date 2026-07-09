-- l37-s01 — the composition registry made COMPLETE (applied live 2026-07-09).
--
-- VIDEO AUDIT CATCH: four compositions lived in remotion/Root.tsx but were
-- never inserted into remotion_compositions — the render endpoint resolves
-- from THIS table, so every queued render of them failed at resolution:
--   · EquityReportReel      — the Video Director SELECTS it for anniversary
--                             equity videos (video-director.ts) → those
--                             ai_video_projects renders were failing LIVE
--   · ExplainerAnimReel     — the animated diagram explainer (in-stack Manim)
--   · PhotoWalkthroughReel  — Ken Burns listing-photo walkthrough
--   · ProductPromoReel      — platform self-marketing reel (platform tier)
-- All four registered with the owner rule applied: branded bookends + QR-
-- carrying outro + VideoCoverThumb thumbnail on every non-selfie video.
--
-- Also: PartnersMeetingReel (the report-video family: weekly show, board
-- packet, pitch, Deal Room) flipped to supports_bookends=true — it is not
-- selfie-type, so it gets the branded intro/outro like everything else.
-- Registry now covers all 29 Root.tsx compositions.

INSERT INTO remotion_compositions (composition_id, display_name, category, orientation, width, height, duration_frames, fps, requires_did_avatar, requires_voiceover, tier_access, is_active, seo_title, seo_description, thumbnail_composition_id, supports_bookends, stock_intro_category, stock_outro_category)
VALUES
('EquityReportReel', 'Home Equity Report', 'market_update', 'square', 1080, 1080, 540, 30, false, true, ARRAY['platform','multi_location','brokerage','team'], true, 'Your home equity, visualized', 'Anniversary equity report reel — appreciation, principal paid, and what it means.', 'VideoCoverThumb', true, 'brand_intro', 'logo_outro'),
('ExplainerAnimReel', 'Animated Explainer', 'explainer', 'square', 1080, 1080, 540, 30, false, true, ARRAY['platform','multi_location','brokerage','team'], true, 'Real estate, explained', 'Animated diagram explainer — the in-stack Manim.', 'VideoCoverThumb', true, 'brand_intro', 'logo_outro'),
('PhotoWalkthroughReel', 'Photo Walkthrough', 'listing', 'square', 1080, 1080, 600, 30, false, false, ARRAY['platform','multi_location','brokerage','team'], true, 'Step inside', 'Ken Burns listing-photo walkthrough reel.', 'VideoCoverThumb', true, 'brand_intro', 'logo_outro'),
('ProductPromoReel', 'Product Promo', 'explainer', 'vertical', 1080, 1920, 450, 30, false, false, ARRAY['platform'], true, 'The AI-run brokerage OS', 'Platform self-marketing promo reel.', 'VideoCoverThumb', true, 'brand_intro', 'logo_outro')
ON CONFLICT (composition_id) DO NOTHING;

UPDATE remotion_compositions
SET supports_bookends = true, stock_intro_category = 'brand_intro', stock_outro_category = 'logo_outro'
WHERE composition_id = 'PartnersMeetingReel';
