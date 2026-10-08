-- scripts/L60-S02-retire-legacy-dead-tables.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- RETIRE LEGACY DEAD TABLES (drift consolidation — "let the others be removed
-- after a full investigation of dependencies").
--
-- Each table below was proven, before this migration, to be:
--   • referenced by ZERO runtime code in app/ or lib/ (no .from() reader/writer), and
--   • dependency-closed (every foreign key into the set is internal to the set —
--     the only external inbound FK was practice_evaluations → training_course_steps,
--     and practice_evaluations is itself a zero-reference leaf), and
--   • empty (0 rows), except training_courses which holds only 3 seed rows that
--     duplicate the three REQUIRED_ONBOARDING_CERTS by name.
--
-- The legacy agent-training spine (training_courses / agent_courses /
-- training_course_steps) had no course-taking runtime — agent_courses was never
-- written — and has been fully superseded by the canonical learning_modules +
-- learning_assignments rail. Its last runtime readers (the Lead-Management cert
-- gate, skill-freshness, and the onboarding progress tracker) were re-pointed onto
-- the canonical rail in the preceding commits, leaving these tables inert.
-- practice_evaluations was a legacy practice-scoring table wired to
-- training_course_steps; commission_records was orphaned DDL never wired.
--
-- Dropped in dependency order (dependents first) so no CASCADE surprises.
-- NOTE: `playbooks` is intentionally NOT dropped — it is unreferenced by code but
-- holds seed content and is an owner-requested capability awaiting wiring, not drift.

DROP TABLE IF EXISTS practice_evaluations;   -- leaf; FK → training_course_steps
DROP TABLE IF EXISTS training_course_steps;  -- FK → training_courses
DROP TABLE IF EXISTS agent_courses;          -- FK → training_courses; never written
DROP TABLE IF EXISTS training_courses;       -- 3 seed rows == the 3 onboarding certs
DROP TABLE IF EXISTS commission_records;     -- orphaned DDL, never wired
