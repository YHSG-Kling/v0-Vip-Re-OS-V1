-- supabase/migrations/m659-memory-video-reel-composition.sql
--
-- ── APPLIED LIVE 2026-09-22 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
--
-- Lane 78D, blind spot (1): the memory video had NO Remotion composition
-- (lane 77D's per-type matrix: "a multi-minute dictation does not fit any
-- registered body window"). remotion/MemoryVideoReel.tsx now renders it on
-- the voiceover host, chaptered, no avatar; the render endpoint resolves
-- compositions FROM THIS TABLE (l37-s01 header), so without this row every
-- queued render of it fails at resolution.
--
-- THE ROW. duration_frames is the CAP (20 min @ 30 fps), mirrored in
-- lib/remotion/composition-geometry.ts and proven equal to remotion/Root.tsx
-- by test:remotion-setup; the film's real length is computed by Root.tsx's
-- calculateMetadata from the chapters' narration. requires_voiceover = true
-- because the composition renders <Audio src={chapter.voiceoverUrl}> in-frame
-- (lib/remotion/content-contract.ts VOICEOVER_CONSUMING_COMPOSITIONS —
-- test:content-contract asserts the live flag equals membership).
-- supports_bookends = false and no stock intro/outro: a keepsake is not
-- marketing (lib/video/finish-spec.ts MemoryVideoReel). tier_access: every
-- paying tier — a solo agent can offer a 20-year seller this service too.
--
-- THE WORD. remotion_compositions.category is CHECK-constrained
-- (scripts/check-vocabularies.ts: affordability … thumbnail) and none of its
-- fourteen values names a family keepsake — 'testimonial' is a customer's
-- account used as marketing, which this product is explicitly not
-- (memory-video-gate.ts: "the family keeps it"). CLAUDE.md §6: one word per
-- idea, so the CHECK gains 'memory' rather than this row wearing a
-- neighbouring word. The constraint name is read off pg_constraint at apply
-- time so a renamed constraint cannot make this a no-op that reports success.
--
-- AFTER APPLYING (integrator):
--   1. npm run schema:regen — check-vocabularies.ts must list
--      remotion_compositions.category with 'memory' (15 values); then
--      npm run -s test:check-vocabulary && npm run -s test:schema-cache-drift.
--   2. Flip this header to the applied banner and the prose mentions in
--      lib/remotion/composition-geometry.ts + lib/video/memory-video-render.ts
--      (search "m659").
--   3. scripts/migration-claim-guard.ts NOT_APPLIED_BASELINE drops back by 1.

DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'public.remotion_compositions'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%category%';
  IF cname IS NULL THEN
    RAISE EXCEPTION 'remotion_compositions: no CHECK constraint on category found — refusing to guess';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = cname AND conrelid = 'public.remotion_compositions'::regclass)) NOT ILIKE '%''memory''%' THEN
    EXECUTE format('ALTER TABLE public.remotion_compositions DROP CONSTRAINT %I', cname);
    EXECUTE format(
      'ALTER TABLE public.remotion_compositions ADD CONSTRAINT %I CHECK (category = ANY (ARRAY[%s]))',
      cname,
      $v$'affordability','agent_avatar','coming_soon','explainer','lead_magnet','listing','market_update','memory','neighborhood','newsletter','open_house','postcard','presentation','testimonial','thumbnail'$v$
    );
  END IF;
END $$;

INSERT INTO remotion_compositions (
  composition_id, display_name, category, orientation, width, height, duration_frames, fps,
  requires_did_avatar, requires_voiceover, tier_access, is_active,
  seo_title, seo_description, thumbnail_composition_id,
  supports_bookends, stock_intro_category, stock_outro_category
)
VALUES (
  'MemoryVideoReel', 'Memory Video', 'memory', 'horizontal', 1920, 1080, 36000, 30,
  false, true, ARRAY['platform','multi_location','brokerage','team','solo_agent'], true,
  'The story of your home', 'Seller-dictated family history of the home — chaptered, in the family''s own words, for the family to keep.', 'VideoCoverThumb',
  false, NULL, NULL
)
ON CONFLICT (composition_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  orientation = EXCLUDED.orientation,
  width = EXCLUDED.width,
  height = EXCLUDED.height,
  duration_frames = EXCLUDED.duration_frames,
  fps = EXCLUDED.fps,
  requires_did_avatar = EXCLUDED.requires_did_avatar,
  requires_voiceover = EXCLUDED.requires_voiceover,
  tier_access = EXCLUDED.tier_access,
  is_active = EXCLUDED.is_active,
  thumbnail_composition_id = EXCLUDED.thumbnail_composition_id,
  supports_bookends = EXCLUDED.supports_bookends,
  stock_intro_category = EXCLUDED.stock_intro_category,
  stock_outro_category = EXCLUDED.stock_outro_category,
  updated_at = now();

-- THE MIRROR RULE, RESTATED (m601's whole-column rule, now with the new
-- member — the NEWEST migration carrying this SET is the one test:content-
-- contract compares to lib/remotion/content-contract.ts
-- VOICEOVER_CONSUMING_COMPOSITIONS; m601 is applied history and is not edited).
UPDATE public.remotion_compositions
   SET requires_voiceover = (composition_id IN (
         'AffordabilitySnapshotReel',
         'AgentTalkingHeadReel',
         'CMAReel',
         'ComingSoonReel',
         'JustListedReel',
         'JustListedReelHorizontal',
         'JustListedReelSquare',
         'JustSoldReelSquare',
         'ListingSectionReel',
         'MemoryVideoReel',
         'NeighborhoodSpotlightReel',
         'NewsletterDigestVideo',
         'OpenHouseAnnounceReel',
         'PhotoWalkthroughReel',
         'TestimonialReel'
       ))
 WHERE requires_voiceover IS DISTINCT FROM (composition_id IN (
         'AffordabilitySnapshotReel',
         'AgentTalkingHeadReel',
         'CMAReel',
         'ComingSoonReel',
         'JustListedReel',
         'JustListedReelHorizontal',
         'JustListedReelSquare',
         'JustSoldReelSquare',
         'ListingSectionReel',
         'MemoryVideoReel',
         'NeighborhoodSpotlightReel',
         'NewsletterDigestVideo',
         'OpenHouseAnnounceReel',
         'PhotoWalkthroughReel',
         'TestimonialReel'
       ));

COMMENT ON COLUMN remotion_compositions.duration_frames IS
  'Registered frame count. For MemoryVideoReel this is the CAP: remotion/Root.tsx calculateMetadata computes the real length from the narration (lib/video/memory-video-composition.ts).';
