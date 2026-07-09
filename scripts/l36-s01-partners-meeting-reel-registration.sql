-- l36-s01 — register PartnersMeetingReel in the LIVE composition registry.
-- APPLIED LIVE 2026-07-09.
--
-- The composition has been in remotion/Root.tsx (id "PartnersMeetingReel",
-- 1920×1080, 900 frames) with a pure props builder since the weekly-show wave,
-- but it was NEVER inserted into remotion_compositions — the render endpoint
-- resolves compositions from THIS table (getComposition), so any queued render
-- would have failed resolution. That is why the weekly reel never had a live
-- producer. The board-packet video (board-packet cron queues it monthly;
-- ?phase=deliver sweeps completed renders) is the composition's first live
-- producer, and this row is what lets it render.
--
-- category/orientation are constrained by CHECKs — 'presentation'/'horizontal'
-- are the honest fits (a leadership presentation, desk/TV viewing). No D-ID /
-- voiceover REQUIREMENTS: the composition renders with or without the avatar
-- PIP (props degrade to photo → initial).

INSERT INTO remotion_compositions (
  composition_id, display_name, category, orientation,
  width, height, duration_frames, fps,
  requires_did_avatar, requires_voiceover, tier_access, is_active,
  seo_title, seo_description, thumbnail_composition_id, supports_bookends
)
VALUES (
  'PartnersMeetingReel', 'Partners'' Meeting — AI Team Recap', 'presentation', 'horizontal',
  1920, 1080, 900, 30,
  false, false, ARRAY['platform','multi_location','brokerage','team'], true,
  'Your AI team presents the numbers',
  'The AI management team presents the period back to leadership — production, finance, and the compliance disposition.',
  'VideoCoverThumb', false
)
ON CONFLICT (composition_id) DO NOTHING;
