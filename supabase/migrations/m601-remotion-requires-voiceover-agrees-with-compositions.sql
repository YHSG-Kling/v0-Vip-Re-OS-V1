-- m601 — remotion_compositions.requires_voiceover agrees with the compositions.
-- ─────────────────────────────────────────────────────────────────────────────
-- APPLIED 2026-09-03 by the integrator (MCP apply_migration; postflight: 14 of 33 rows true, matching the code set) (CLAUDE.md §3). Lane RM-B wrote this on 2026-09-03; only
-- the integrator applies it. Nothing to regenerate afterwards — see ORDERING.
--
-- MEASURED BEFORE WRITING THIS (live db, hrvaqgvukzxfskkcrwbt, 2026-09-03):
--
--   public.remotion_compositions ................................ 33 rows
--   requires_voiceover = true on exactly these 9:
--     AgentExplainerReel, AgentTalkingHeadReel, BuyerConsultationSlide,
--     EquityReportReel, ExplainerAnimReel, JustListedReelHorizontal,
--     ListingPresentationSlide, MarketUpdateReel, NeighborhoodSpotlightReel
--
--   The compositions under remotion/ that actually render
--   `<Audio src={…voiceoverUrl}>` (grep, comment-stripped; the set
--   scripts/remotion-setup-guard.ts §5 proves complete) are these 14:
--     AffordabilitySnapshotReel, AgentTalkingHeadReel, CMAReel, ComingSoonReel,
--     JustListedReel, JustListedReelHorizontal, JustListedReelSquare,
--     JustSoldReelSquare, ListingSectionReel, NeighborhoodSpotlightReel,
--     NewsletterDigestVideo, OpenHouseAnnounceReel, PhotoWalkthroughReel,
--     TestimonialReel
--
--   Agreement between the two: 3 rows (AgentTalkingHeadReel,
--   JustListedReelHorizontal, NeighborhoodSpotlightReel). Disagreement: 17 rows —
--     true → false (6): AgentExplainerReel, BuyerConsultationSlide,
--                       EquityReportReel, ExplainerAnimReel,
--                       ListingPresentationSlide, MarketUpdateReel
--     false → true (11): AffordabilitySnapshotReel, CMAReel, ComingSoonReel,
--                        JustListedReel, JustListedReelSquare,
--                        JustSoldReelSquare, ListingSectionReel,
--                        NewsletterDigestVideo, OpenHouseAnnounceReel,
--                        PhotoWalkthroughReel, TestimonialReel
--   The remaining 13 rows are false on both sides and do not change.
--
-- WHY
--
--   TWO SPELLINGS OF ONE FACT (§6). The column was hand-seeded by m168 as
--   "this composition needs a narration" and never re-derived; the code set
--   (formerly lib/video/avatar-render-orchestrator.ts
--   VOICEOVER_CONSUMING_COMPOSITIONS, now
--   lib/remotion/content-contract.ts VOICEOVER_CONSUMING_COMPOSITIONS) was
--   measured from the compositions themselves. Both fed the SAME ledger column,
--   remotion_composition_renders.used_voiceover:
--     · the avatar handoff stamped it from the code set,
--     · lib/agents/asset-manager-actions.ts start_render / restart_failed_render
--       and lib/remotion/render-coordinator.ts finalize stamped it from THIS
--       column.
--   So a ListingPresentationSlide render with no audio at all was ledgered as
--   narrated, and a JustListedReel whose narration is IN the frames was
--   ledgered as silent — depending only on which door the render came through.
--
--   THE MEANING CHOSEN IS THE MEASURABLE ONE: true iff the composition renders
--   `<Audio src={voiceoverUrl}>`. It is provable in CI with no database, which
--   is why the CODE set is the source of truth and this column is its MIRROR
--   (the same relationship COMPOSITION_GEOMETRY has to the live geometry, in
--   the other direction). After this migration every reader of the column and
--   every reader of the set get one answer, and
--   scripts/content-contract-guard.ts §15 compares the two whenever it can reach
--   the live table (and says it skipped otherwise).
--
--   WHAT THE COLUMN NO LONGER MEANS. "This composition's producer spends TTS."
--   The Director's EquityReportReel / MarketUpdateReel / ExplainerAnimReel /
--   AgentExplainerReel lane narrates through the snake `voiceover_url` FINISH
--   key (muxed by the coordinator after the frames render), which is real TTS
--   spend and real narration — and the coordinator records it by flipping
--   used_voiceover when the mux lands. The cost ledger for that spend is
--   ai_tool_usage; lib/remotion/registry.ts estimateCompositionCost names this
--   blind spot beside its number.
--
-- WHY A RULE AND NOT 17 UPDATE STATEMENTS
--
--   The whole column is set from the set, in one statement, so the migration is
--   idempotent and re-runnable, and a row that drifts later is re-aligned by
--   re-applying rather than by a new migration. A composition registered after
--   this migration lands with the m168 default (false) and is picked up by §15
--   the moment it is added to the code set.
--
-- NO VOCABULARY IS ADDED. Boolean column, no CHECK, no FK, no index: nothing to
-- regenerate in scripts/check-vocabularies.ts, scripts/schema-snapshot.ts,
-- scripts/schema-fk-map.ts or scripts/live-tables.ts.
--
-- ORDERING (integrator): preflight → apply → postflight → done.
--
-- PREFLIGHT (run first; expect the 9-row list in the header):
--   SELECT composition_id FROM public.remotion_compositions
--    WHERE requires_voiceover ORDER BY composition_id;
--
-- POSTFLIGHT (expect: 14 rows, exactly the second list; and 0 rows):
--   SELECT composition_id FROM public.remotion_compositions
--    WHERE requires_voiceover ORDER BY composition_id;
--   SELECT composition_id FROM public.remotion_compositions
--    WHERE requires_voiceover <> (composition_id IN (
--      'AffordabilitySnapshotReel','AgentTalkingHeadReel','CMAReel','ComingSoonReel',
--      'JustListedReel','JustListedReelHorizontal','JustListedReelSquare',
--      'JustSoldReelSquare','ListingSectionReel','NeighborhoodSpotlightReel',
--      'NewsletterDigestVideo','OpenHouseAnnounceReel','PhotoWalkthroughReel',
--      'TestimonialReel'));
--   Then: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npm run test:content-contract
--   — §15 must print "the LIVE requires_voiceover column mirrors the set" ✓.

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
         'NeighborhoodSpotlightReel',
         'NewsletterDigestVideo',
         'OpenHouseAnnounceReel',
         'PhotoWalkthroughReel',
         'TestimonialReel'
       ));
-- expect: UPDATE 17
