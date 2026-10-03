-- m565 — THE ANNIVERSARY VIDEO WAS WEARING ANOTHER PRODUCT'S NAME.
--
-- ORPHAN DOCTRINE §1.2 + §6 (one vocabulary per function). The capability is
-- wanted, no duplicate spelling of it exists, so the missing half is BUILT.
--
-- THE OWNER'S RULING, verbatim, and it REVERSES the previous wave's fix:
--   "memory video is for sellers that have been in their home more than 20 years
--    which is a seller dictated video going over the history of the house so the
--    family has it (this is a special service that can be offered)"
--
-- So `memory_video` is a DISTINCT PRODUCT — a seller-dictated family history for
-- a 20-year-plus homeowner, offered as a special service — and not a label for
-- the yearly home-anniversary/equity clip.
--
-- WHAT THE PREVIOUS WAVE ACTUALLY FIXED, AND WHAT IT BROKE
-- -------------------------------------------------------
-- lib/video/intro-video-reactor.ts stamped the home-anniversary avatar video
-- video_type='just_sold'. Nobody sold anything. That was not merely inaccurate:
-- lib/kernel/video-coordination.ts::resolveVideoKind falls back to video_type
-- when video_metadata.promo_event_type is absent (this row has never carried
-- one), 'just_sold' is in PROMOTABLE_VIDEO_KINDS, and so publishVideoCoordination
-- Signals raised an `ads_manager:video_ready` signal proposing PAID SPEND to
-- promote a 1:1 equity message addressed to one named past client. The previous
-- wave re-stamped it 'memory_video' because lib/video/video-director.ts's
-- videoTypeForSituation already mapped SituationKind 'anniversary' there and the
-- live CHECK admitted it. The ad-spend defect was real and the fix held. The
-- NAMING defect it introduced is what this migration closes: two different
-- products were sharing one word, which is the §6 defect in its literal form.
--
-- WHY 'home_anniversary' AND NOT A NEW COINAGE (§6)
-- ------------------------------------------------
-- This moment ALREADY has a spelling in the live database, and it is used twice:
--   · public.agent_intro_videos.trigger CHECK admits exactly
--     ('contact_agent_assigned','home_anniversary') — the ledger row this very
--     video is filed under says 'home_anniversary'.
--   · public.contacts.home_anniversary is the date column the trigger fires from.
-- Coining 'anniversary' or 'equity_anniversary' beside those would be a THIRD
-- spelling of one idea. The code-side spellings agree: IntroTrigger in
-- lib/video/intro-video-reactor.ts is the same union as the trigger CHECK.
-- (lib/video/video-director.ts's SituationKind 'anniversary' is a different
-- vocabulary — the Director's situation taxonomy — and it MAPS onto this value;
-- one mapper, one target, no second spelling of the video_type itself.)
--
-- VERIFIED LIVE ON hrvaqgvukzxfskkcrwbt BEFORE THIS MIGRATION
-- ----------------------------------------------------------
--   · ai_video_projects_video_type_check admitted exactly 16 values:
--       listing_tour, pre_appointment, coming_soon, just_listed, open_house_promo,
--       just_sold, agent_intro, market_update, education, social_reel,
--       listing_promo, testimonial, welcome, presentation_chapter, memory_video,
--       avatar_explainer
--     NONE of them names an anniversary or an equity moment.
--   · A rolled-back probe INSERT proved the constraint is the thing refusing:
--       home_anniversary       = REFUSED (23514)
--       memory_video           = ADMITTED   ← the probe can tell the two apart
--       not_a_real_video_type  = REFUSED (23514)
--   · SELECT video_type, count(*) FROM ai_video_projects GROUP BY 1 → 0 rows.
--     There is nothing to re-stamp today. The UPDATE below is written anyway,
--     because a row can land between writing this file and applying it and
--     CLAUDE.md §3 is explicit that the gap between the file and the database is
--     where that class of loss lives.
--
-- WHAT MUST NOT CHANGE, AND IS ASSERTED IN scripts/anniversary-video-delivery-simulator.ts
-- ---------------------------------------------------------------------------------------
--   · 'home_anniversary' must NOT be in lib/kernel/video-coordination.ts
--     PROMOTABLE_VIDEO_KINDS, or the paid-spend defect returns.
--   · 'home_anniversary' must NOT be in lib/kernel/welcome-personal-video.ts
--     PERSONAL_WELCOME_VIDEO_TYPES, or an anniversary clip can be served to a
--     brand-new client as their welcome video.
--   · 'home_anniversary' must NOT be in lib/orchestrator/internal.ts
--     personalVideoTypes: the anniversary already owns TWO delivery halves (the
--     email sweep and the portal card, both in
--     app/api/cron/intro-video-email-backfill), so a per-contact email+SMS draft
--     would be a third touch about one clip. The hasOwnDeliveryRail guard that
--     the previous wave added stays as the structural backstop.
--
-- THIS MIGRATION INVALIDATES scripts/check-vocabularies.ts, which is GENERATED
-- (CLAUDE.md §3). Regenerated in the same change through
-- scripts/generate-check-vocabularies.ts — never hand-edited. No column is added
-- or dropped, so scripts/schema-snapshot.ts and scripts/schema-fk-map.ts are
-- unchanged, and no table is created or retired, so scripts/live-tables.ts is
-- unchanged.

BEGIN;

-- ── 1. The word this video has needed all along ─────────────────────────────
-- Widening a CHECK by DROP + ADD revalidates every existing row. There are none
-- today, and every value in the old list survives into the new one, so no row
-- that was legal can become illegal here.
ALTER TABLE public.ai_video_projects
  DROP CONSTRAINT ai_video_projects_video_type_check;

ALTER TABLE public.ai_video_projects
  ADD CONSTRAINT ai_video_projects_video_type_check
  CHECK (video_type = ANY (ARRAY[
    'listing_tour'::text,
    'pre_appointment'::text,
    'coming_soon'::text,
    'just_listed'::text,
    'open_house_promo'::text,
    'just_sold'::text,
    'agent_intro'::text,
    'market_update'::text,
    'education'::text,
    'social_reel'::text,
    'listing_promo'::text,
    'testimonial'::text,
    'welcome'::text,
    'presentation_chapter'::text,
    'memory_video'::text,
    'avatar_explainer'::text,
    'home_anniversary'::text
  ]));

-- ── 2. Give back the rows that were only ever borrowing the name ────────────
-- The ONLY writer that ever stamped 'memory_video' on an anniversary clip is
-- lib/video/intro-video-reactor.ts, and it stamps video_metadata.trigger =
-- 'home_anniversary' on the same row — so the population is identifiable without
-- guessing. A row a human or the Director genuinely commissioned as a memory
-- video carries no such trigger key and is left alone.
DO $$
DECLARE moved bigint;
BEGIN
  WITH restamped AS (
    UPDATE public.ai_video_projects
       SET video_type = 'home_anniversary'
     WHERE video_type = 'memory_video'
       AND video_metadata->>'trigger' = 'home_anniversary'
    RETURNING 1
  )
  SELECT count(*) INTO moved FROM restamped;
  RAISE NOTICE 'm565: % anniversary row(s) re-stamped off memory_video', moved;
END $$;

-- ── 3. Say in the database which product is which ───────────────────────────
COMMENT ON COLUMN public.ai_video_projects.video_type IS
  'The KIND of video, not its status. Two values are easy to confuse and are '
  'deliberately separate (m565): '
  '''home_anniversary'' is the yearly avatar-led equity/anniversary clip a past '
  'client receives on the anniversary of their close — commissioned by '
  'lib/kernel/anniversary-equity.ts through lib/video/intro-video-reactor.ts '
  '(dispatchAnniversaryVideo), delivered to that ONE person''s portal card, and '
  'deliberately NOT promotable: it is never a candidate for paid social spend. '
  '''memory_video'' is a SEPARATE, SELLER-DICTATED product — a family history of '
  'the house, offered as a special service to a seller who has lived there more '
  'than 20 years, so the family keeps it. Its script_content is the SELLER''S OWN '
  'WORDS: video_metadata.authored_by = ''seller'' and video_metadata.dictation '
  'carries the captured segments. A model may order, trim and caption those '
  'words; it may not invent family history. Eligibility and the authorship '
  'boundary are enforced in lib/video/memory-video-gate.ts.';

COMMIT;
