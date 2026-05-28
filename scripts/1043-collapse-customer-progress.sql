-- ============================================================================
-- Migration 1043 — Collapse contact_education_progress into learning_assignments
-- ============================================================================
--
-- Pre-production cleanup. contact_education_progress was a per-customer
-- per-lesson completion tracker keyed by (contact_id, lesson_key).
-- learning_assignments already handles this via (contact_id, module_id,
-- status='completed', completed_at) — so the two tables are duplicative.
--
-- After this migration, customer lesson completion is tracked exclusively
-- through learning_assignments with contact_id set. The lesson is identified
-- by module_id (uuid) rather than lesson_key (text).
--
-- Also adds a unique index on (contact_id, module_id) for assignments
-- targeting customers so upserts on completion are race-safe.
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS contact_education_progress CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_la_contact_module
  ON learning_assignments (contact_id, module_id)
  WHERE contact_id IS NOT NULL;

COMMIT;
