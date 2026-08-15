-- ============================================================================
-- Migration 1044 — Replace partial unique index with full UNIQUE constraint
-- ============================================================================
--
-- Migration 1043 added uq_la_contact_module as a partial unique index
-- (WHERE contact_id IS NOT NULL). PostgreSQL accepts ON CONFLICT against
-- partial indexes only with the predicate inline, which Supabase's REST
-- upsert helper does NOT emit. Switch to plain UNIQUE constraints so
-- ON CONFLICT (contact_id, module_id) works from both raw SQL and the
-- supabase-js .upsert() helper.
--
-- NULLs are still treated as distinct, so an agent assignment (contact_id
-- IS NULL) does NOT collide with a customer assignment for the same module.
-- We add matching constraints for agent_user_id and staff_user_id so
-- duplicate same-target assignments are blocked everywhere.
-- ============================================================================

BEGIN;

DROP INDEX IF EXISTS uq_la_contact_module;

ALTER TABLE learning_assignments
  ADD CONSTRAINT uq_la_contact_module UNIQUE (contact_id, module_id);
ALTER TABLE learning_assignments
  ADD CONSTRAINT uq_la_agent_module   UNIQUE (agent_user_id, module_id);
ALTER TABLE learning_assignments
  ADD CONSTRAINT uq_la_staff_module   UNIQUE (staff_user_id, module_id);

COMMIT;
