-- ── APPLIED LIVE 2026-09-22 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
-- m658 — remotion_compositions.duration_frames becomes the CAP, not the body.
--
-- OWNER RULING (wave 78, 2026-09-22): "you hardcoded the length of the video
-- body for each video, what happens with any new videos and not sure if that
-- is the best practice because the video needs to be long enough to achieve
-- the reason for making the video."
--
-- WHAT CHANGES. Every narration-driven composition's real duration is now
-- COMPUTED per render (remotion/Root.tsx calculateMetadata → lib/video/
-- duration-model.ts planCompositionDuration: bookends + a body derived from
-- the fitted narration, inside the purpose's max). The registered
-- duration_frames is therefore the CAP the composition may reach — bookends +
-- the longest purpose max it serves, at 30 fps (requiredCapFrames) — and no
-- longer the fixed length every render had. No schema change: the column keeps
-- its type and NOT NULL; only the values move. Stills (duration_frames = 1),
-- the two slide components (180) and the two fixed-body chart reels (450/720)
-- are untouched.
--
-- The mirror lib/remotion/composition-geometry.ts carries the same numbers
-- (test:remotion-setup §3 proves Root.tsx == mirror; §3b proves mirror == live
-- when a service key is present, and SAYS IT SKIPPED otherwise).
--
-- READERS OF THIS COLUMN, and why each is fine with a cap:
--   · render cache key (lib/remotion/composition-cache.ts) — the props that
--     size the render are in the key already; a cap in the key is stable.
--   · render-decision isStillComposition — ≤1 vs >1, unchanged.
--   · render-coordinator narration pad / music fade — now read the PLANNED
--     seconds (renderedCompositionSeconds), not this column.
--   · registry estimateCompositionCost / render-cache secondsAvoided — read the
--     cap and therefore OVER-estimate; conservative direction, noted.

update public.remotion_compositions set duration_frames = v.cap
from (values
  ('JustListedReel',            1500),  -- 60 + 45s listing_promo + 90
  ('JustListedReelSquare',      1470),  -- 60 + 45s + 60
  ('JustListedReelHorizontal',  1530),  -- 90 + 45s + 90
  ('JustSoldReelSquare',        1470),  -- 60 + 45s + 60
  ('ComingSoonReel',            1500),  -- 90 + 45s + 60
  ('OpenHouseAnnounceReel',     1500),  -- 90 + 45s + 60
  ('PhotoWalkthroughReel',      2850),  -- 60 + 90s photo_walkthrough + 90
  ('AgentTalkingHeadReel',      2820),  -- 60 + 90s (welcome 60 / seller_update 90) + 60
  ('AgentExplainerReel',        2880),  -- 90 + 90s (explainer 90 / lead_reel 60) + 90
  ('TeammateExplainerReel',     2865),  -- 75 + 90s explainer + 90
  ('ExplainerAnimReel',         2880),  -- 90 + 90s explainer + 90
  ('MarketUpdateReel',          2370),  -- 60 + 75s market_update + 60
  ('EquityReportReel',          2430),  -- 60 + 75s anniversary_equity + 120
  ('TestimonialReel',           1920),  -- 60 + 60s testimonial + 60
  ('NeighborhoodSpotlightReel', 1950),  -- 90 + 60s neighborhood_spotlight + 60
  ('NewsletterDigestVideo',     1950),  -- 60 + 60s newsletter + 90
  ('ListingSectionReel',        1350),  -- 0 + 45s listing_presentation_section + 0
  ('PartnersMeetingReel',       3720),  -- 75 + 120s partners_meeting + 45
  ('ProductPromoReel',          3720)   -- 0 + 120s product_demo + 120
) as v(composition_id, cap)
where remotion_compositions.composition_id = v.composition_id;
