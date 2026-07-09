-- l42-s01 — the DOOR HANGER joins the print family (applied live 2026-07-09).
-- Geo-farming's highest-converting print moment had no asset: a listing
-- CLOSES and the agent should be door-knocking the street with "JUST SOLD"
-- + a scan-to-value QR the same day. DoorHanger: 4.25x11 @ 300 DPI (bleed
-- canvas 1350x3375), still (durationInFrames=1), dashed die-cut knob guide,
-- headline + address + hero photo + neighbor hook + QR + agent block +
-- EHO/anti-solicitation footer. Produced autonomously by runDoorHangers on
-- the daily video-plays cron (idempotent per listing, entity_type
-- door_hanger). Registered static_card (finish-spec: stills ARE the
-- deliverable — no bookends/music/thumbnail).
INSERT INTO remotion_compositions (composition_id, display_name, category, orientation, width, height, duration_frames, fps, requires_did_avatar, requires_voiceover, tier_access, is_active, seo_title, seo_description, thumbnail_composition_id, supports_bookends)
VALUES ('DoorHanger', 'Door Hanger (4.25x11 print)', 'listing', 'static_card', 1350, 3375, 1, 30, false, false, ARRAY['platform','multi_location','brokerage','team'], true, 'Just-sold door hanger', 'Print-ready 4.25x11 just-sold door hanger with scan-to-value QR.', NULL, false)
ON CONFLICT (composition_id) DO NOTHING;
