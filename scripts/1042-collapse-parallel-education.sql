-- ============================================================================
-- Migration 1042 — Collapse parallel education stores into learning_modules
-- ============================================================================
--
-- Pre-production cleanup. No data to migrate, so we just drop the parallel
-- tables and let everything flow through the Sprint 7 kernel:
--
--   learning_modules                       — canonical authoring record
--   learning_module_channel_publications   — fan-out to channel tables
--   learning_assignments                   — per-actor next-best-item
--
-- Dropped:
--   academy_content       — duplicate authoring (sop/playbook_breakdown/etc.)
--   educational_moments   — duplicate authoring + transaction delivery log
--   academy_content_type  — enum, now orphan
--   170-add-academy-stored-procedures fns  — get_top_contributors,
--                                            increment_academy_view
--
-- Added:
--   learning_modules.view_count         — preserves the engagement signal
--                                          academy_content had
--   learning_modules.is_ai_generated    — preserves the AI provenance flag
--                                          educational_moments had
--   increment_learning_module_view fn   — replaces increment_academy_view
--
-- Kept (orthogonal domain):
--   template_marketplace — clones playbooks → plan_tasks. Not education.
--   template_feedback    — feedback on templates. Not education.
-- ============================================================================

BEGIN;

-- 1. Drop stored procedures tied to academy_content -------------------------
DROP FUNCTION IF EXISTS get_top_contributors() CASCADE;
DROP FUNCTION IF EXISTS increment_academy_view(uuid) CASCADE;

-- 2. Drop the parallel education tables -------------------------------------
DROP TABLE IF EXISTS educational_moments CASCADE;
DROP TABLE IF EXISTS academy_content      CASCADE;
DROP TYPE  IF EXISTS academy_content_type CASCADE;

-- 3. Extend learning_modules with the signals the dropped tables carried ---
ALTER TABLE learning_modules
  ADD COLUMN IF NOT EXISTS view_count       int     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_ai_generated  boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_lm_view_count
  ON learning_modules(brokerage_id, view_count DESC)
  WHERE status = 'published';

-- 4. View-count increment helper (replaces increment_academy_view) ----------
CREATE OR REPLACE FUNCTION increment_learning_module_view(p_module_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE learning_modules
     SET view_count = view_count + 1,
         updated_at = now()
   WHERE id = p_module_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION increment_learning_module_view(uuid) TO authenticated;

COMMIT;
