-- m218 — register the EquityReportReel composition.
--
-- The video face of lib/kernel/anniversary-equity.ts: on a past client's
-- yearly closing anniversary the Sphere Manager already pushes a portal value
-- card + one gated agent note with the REAL equity story (estimated current
-- value vs what they paid, equity ONLY when the original loan is on file,
-- otherwise appreciation-only and the copy SAYS so). When the agent has a voice
-- + avatar profile configured, this composition is the OPTIONAL personalized
-- reel that rides the same numbers.
--
-- Registering it makes EquityReportReel a first-class registry citizen so it
-- flows through the whole agentic loop: tier gate (canAccessComposition) → cost
-- estimate → render queue (m172) → companion VideoCoverThumb. 1080×1080 square,
-- 18s (540 frames). requires_did_avatar=false: the avatar PIP is OPTIONAL —
-- the reel renders cleanly as a pure Remotion stat-card video when no avatar is
-- configured (text-only path). Available to every tier (lowest = solo_agent →
-- all tiers inherit).

insert into public.remotion_compositions (
  composition_id, display_name, category, orientation, width, height,
  duration_frames, fps, requires_did_avatar, requires_voiceover, tier_access,
  is_active, seo_title, seo_description, thumbnail_composition_id,
  supports_bookends, stock_intro_category, stock_outro_category, asset_manager_notes
) values (
  'EquityReportReel',
  'Anniversary Equity Reel',
  'market_update', 'square', 1080, 1080,
  540, 30, false, false, array['solo_agent'],
  true,
  'Your annual home-equity update — estimated value, growth, and equity',
  'A warm yearly home-anniversary equity reel for a past client: estimated current value vs what they paid, estimated value growth, and estimated equity when the original loan is on file (otherwise appreciation only). Every figure is an estimate, not an appraisal. Optional D-ID + ElevenLabs avatar narration.',
  'VideoCoverThumb',
  true, 'brand_intro', 'logo_outro',
  'Optional avatar reel for the anniversary_equity burn domain. Numbers are the REAL computeEquityLine output (estimated value, appreciation, equity-or-appreciation-only); the outro carries the tracked anniversary QR (mintVideoQr kind anniversary → anniversary_video → the portal equity card). Honest appreciation-only rendering when estimatedEquity is null.'
)
on conflict (composition_id) do update set
  display_name      = excluded.display_name,
  category          = excluded.category,
  duration_frames   = excluded.duration_frames,
  seo_title         = excluded.seo_title,
  seo_description   = excluded.seo_description,
  thumbnail_composition_id = excluded.thumbnail_composition_id,
  supports_bookends = excluded.supports_bookends,
  is_active         = true;
