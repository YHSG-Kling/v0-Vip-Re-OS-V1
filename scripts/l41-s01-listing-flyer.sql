-- l41-s01 — the LISTING FLYER closes the print family (applied live 2026-07-09).
-- The QR system anticipated material kind `listing_flyer` and the constants
-- carried `marketing_flyer`, but no flyer composition existed — postcards
-- were the only print pieces. ListingFlyer: 8.5x11 @ 300 DPI (bleed canvas
-- 2625x3375), still (durationInFrames=1), hero photo + price/address band +
-- facts strip + highlights + agent block + tracked scan-to-tour QR + EHO/
-- license footer. Registered as static_card (finish-spec: stills ARE the
-- deliverable — no bookends/music/thumbnail).
INSERT INTO remotion_compositions (composition_id, display_name, category, orientation, width, height, duration_frames, fps, requires_did_avatar, requires_voiceover, tier_access, is_active, seo_title, seo_description, thumbnail_composition_id, supports_bookends)
VALUES ('ListingFlyer', 'Listing Flyer (8.5x11 print)', 'listing', 'static_card', 2625, 3375, 1, 30, false, false, ARRAY['platform','multi_location','brokerage','team'], true, 'Open-house flyer', 'Print-ready 8.5x11 listing flyer with tracked QR.', NULL, false)
ON CONFLICT (composition_id) DO NOTHING;
