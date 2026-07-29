-- m299-rejected-write-vocabularies.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- NINETEEN WRITES THAT WERE SILENTLY REJECTED.
--
-- Triaging the remaining CHECK-vocabulary baseline by OPERATION rather than by
-- table split it cleanly: 19 of the entries were not filters at all, they were
-- INSERT/UPDATE payloads. A filter on an impossible value returns no rows; a
-- WRITE of one loses the row. Every one of these was a record the product
-- believed it had made.
--
-- Only FOUR needed a schema change. The other fifteen were the code using a
-- word the column already had under another name, or writing a value that means
-- "unknown" into a NULLABLE column that already says that with NULL. Those are
-- repointed in code, not legislated into the database — see the simulator for
-- the per-case reasoning.
--
-- 1. calendar_sync_logs.direction += 'both'
--    The column admitted push | pull. A two-way calendar sync is neither, and
--    the two-way syncer is what actually writes this row, so every sync log it
--    produced was rejected. 'both' is a real third state, not a synonym.
--
-- 2. voice_calls.call_type += 'zoom_meeting'
--    Admitted agent_call | ai_isa_call | vapi_inbound | warm_transfer. The Zoom
--    lane is a built, owner-directed feature (lib/connections/zoom.ts, the
--    recording webhook, the meeting room) and a convened Zoom meeting is none of
--    those four. Its voice_calls row — the anchor the transcript and the meeting
--    recap hang off — could not be written at all.
--
-- 3. ad_insights.source_type += 'competitor_analysis'
--    Admitted competitor_ad | competitor_post, i.e. a single observed artifact.
--    The row being written is the AI's ANALYSIS derived from those artifacts
--    (insight_type recommendation / competitor_launch / creative_trend), which
--    is a third source class, and source_type is NOT NULL so there was nothing
--    to fall back to. The competitor-monitor produced no insights.
--
-- 4. listing_packet_jobs.job_type += 'full_packet'
--    Admitted five individual packets (mls, seller, open_house_booklet, social,
--    offer). "All of them" is a distinct job, not one of the five, and job_type
--    is NOT NULL — so the full-packet job could never be queued.
--
-- All four are additive: nothing previously accepted is now rejected.

ALTER TABLE public.calendar_sync_logs
  DROP CONSTRAINT IF EXISTS calendar_sync_logs_direction_check;
ALTER TABLE public.calendar_sync_logs
  ADD CONSTRAINT calendar_sync_logs_direction_check CHECK (
    direction = ANY (ARRAY['push', 'pull', 'both'])   -- m299
  );

ALTER TABLE public.voice_calls
  DROP CONSTRAINT IF EXISTS voice_calls_call_type_check;
ALTER TABLE public.voice_calls
  ADD CONSTRAINT voice_calls_call_type_check CHECK (
    call_type = ANY (ARRAY['agent_call', 'ai_isa_call', 'vapi_inbound', 'warm_transfer',
                           'zoom_meeting'])           -- m299
  );

ALTER TABLE public.ad_insights
  DROP CONSTRAINT IF EXISTS ad_insights_source_type_check;
ALTER TABLE public.ad_insights
  ADD CONSTRAINT ad_insights_source_type_check CHECK (
    source_type = ANY (ARRAY['competitor_ad', 'competitor_post',
                             'competitor_analysis'])  -- m299
  );

ALTER TABLE public.listing_packet_jobs
  DROP CONSTRAINT IF EXISTS listing_packet_jobs_job_type_check;
ALTER TABLE public.listing_packet_jobs
  ADD CONSTRAINT listing_packet_jobs_job_type_check CHECK (
    job_type = ANY (ARRAY['mls_packet', 'seller_packet', 'open_house_booklet',
                          'social_packet', 'offer_packet',
                          'full_packet'])             -- m299
  );
