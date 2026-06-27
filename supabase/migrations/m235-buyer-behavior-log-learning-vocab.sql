-- m235-buyer-behavior-log-learning-vocab.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- FIX: the buyer-graph LEARNING LOOP was silently dead. buyer_behavior_log.signal_type carried a
-- CHECK that allowed ONLY event-telemetry names (property_viewed, property_saved, tour_stop_rated…),
-- but the learning engine (lib/behavior-learning/preference-updater.ts) and tour-planner write the
-- SEMANTIC weighted vocabulary (saved, love_it, like_it, maybe, dismissed, not_for_us, viewed) and
-- buyer-insights READS it. Every learner INSERT failed the constraint → the table stayed empty →
-- property_preferences never learned from behavior, and buyer-insights always read zero.
--
-- Resolution (investigated: both vocabularies are legitimately used by different subsystems —
-- event vocab by telemetry writers + pattern-detector, semantic vocab by the learner + insights):
-- widen the CHECK to the UNION of both. Table is empty at migration time, so no data backfill.
-- The canonical learning vocab is the 7 SIGNAL_WEIGHTS keys; tour-planner's legacy 'no' is migrated
-- in code to 'not_for_us' (no new synonym enshrined here).

ALTER TABLE buyer_behavior_log DROP CONSTRAINT IF EXISTS buyer_behavior_log_signal_type_check;

ALTER TABLE buyer_behavior_log ADD CONSTRAINT buyer_behavior_log_signal_type_check
  CHECK (signal_type = ANY (ARRAY[
    -- Event telemetry vocabulary (search-client, pattern-detector, etc.)
    'property_viewed','property_saved','property_dismissed','property_shared',
    'search_executed','filter_applied','price_range_adjusted','tour_stop_rated',
    'showing_attended','showing_no_show','offer_created','offer_declined',
    'alert_opened','alert_dismissed','portal_visit','search_time_spent',
    -- Semantic learning vocabulary (preference-updater SIGNAL_WEIGHTS + tour-planner + showing feedback)
    'saved','love_it','like_it','maybe','dismissed','not_for_us','viewed'
  ]::text[]));
