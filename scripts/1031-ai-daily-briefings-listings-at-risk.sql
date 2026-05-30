-- ============================================================================
-- ai_daily_briefings: add listings_at_risk jsonb column
-- ============================================================================
--
-- Mirrors the existing `deals_at_risk` jsonb column so the morning briefing
-- can surface active listings flagged by the Listing Health Radar (migration
-- 1030) the same way it surfaces under-contract deals flagged by deal-health.
--
-- Each entry shape (TS: ListingAtRisk):
--   { listing_id: uuid, address: string, reason: string,
--     risk_level: 'watch'|'at_risk'|'critical', score: number }
--
-- Default '[]' so existing briefings stay readable and clients reading the
-- field never get null.
-- ============================================================================

ALTER TABLE ai_daily_briefings
  ADD COLUMN IF NOT EXISTS listings_at_risk jsonb NOT NULL DEFAULT '[]'::jsonb;
