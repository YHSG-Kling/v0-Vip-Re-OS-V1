-- =====================================================
-- MIGRATION m625: agent_reviews.auto_publish_at
-- ── APPLIED LIVE 2026-09-12 by the integrator (Supabase MCP apply_migration; schema snapshot regenerated the same day). ──
-- =====================================================
--
-- WAVE 61 LANE 61C — the "review" half of app/actions/settings/
-- reputation-preferences.ts::autoRespondMode.
--
-- Wave 60 wired "auto" (aiGenerateReviewResponse publishes immediately through
-- respondToReview when autoRespondMode = "auto"). "review" was left as a
-- straight draft-and-wait — indistinguishable from "off" — because there was
-- nowhere on agent_reviews to record WHEN a draft started its approval clock,
-- so no cron could ever compute "N hours have passed, publish it."
--
-- This is that column. `auto_publish_at` is set by aiGenerateReviewResponse
-- (app/actions/ai-review-automation.ts) the moment a "review"-mode draft is
-- written: now() + agents.notification_preferences.review_auto_respond_
-- approval_hours. The cron app/api/cron/review-response-auto-publish (every
-- 30 min, CRON_REGISTRY) publishes any row whose window has elapsed, through
-- the SAME tenant-checked lib/kernel/reputation.ts::respondToReview command
-- the manual Publish button and the "auto" mode already use — never a raw
-- UPDATE. respondToReview now clears auto_publish_at on EVERY response
-- (edit-and-save, manual publish, or the cron's own auto-publish), which is
-- the reject/edit path: an agent who edits or manually publishes a drafted
-- response before the window elapses stops the clock, because a human already
-- acted on it.
--
-- NULLABLE, no default: "off" and "auto" mode drafts never set it, and the
-- cron's WHERE clause (`auto_publish_at IS NOT NULL AND auto_publish_at <=
-- now()`) already excludes every row this migration does not touch — so a
-- backfill is not needed and would misdate every review drafted before this
-- column existed as "already elapsed."

ALTER TABLE agent_reviews
  ADD COLUMN IF NOT EXISTS auto_publish_at timestamptz;

COMMENT ON COLUMN agent_reviews.auto_publish_at IS
  'Set when a "review"-mode AI draft is written (aiGenerateReviewResponse): '
  'the response auto-publishes via respondToReview once now() passes this '
  'timestamp, unless the agent edits or manually publishes first (both clear '
  'this column). NULL for "off"/"auto" mode drafts and for any already-'
  'published or already-answered review.';

-- Partial index: the cron's only query shape is "unpublished drafts whose
-- window has elapsed" — indexing the other 99% of rows (auto_publish_at IS
-- NULL, or already published) would cost writes for a scan the cron never runs.
CREATE INDEX IF NOT EXISTS idx_agent_reviews_auto_publish_pending
  ON agent_reviews (auto_publish_at)
  WHERE auto_publish_at IS NOT NULL AND is_published = false;
