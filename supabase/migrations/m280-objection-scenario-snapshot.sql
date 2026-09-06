-- m280 — Objection practice scenarios can be AI-generated from real calls
-- (not just the static library). Generated scenarios aren't in the code
-- library, so the full scenario definition is persisted on the session row —
-- submit/end resolve the scenario from this snapshot instead of the static
-- getScenarioByKey lookup.
--
-- Applied to the live database 2026-07-26 (MCP migration
-- add_scenario_snapshot_to_objection_training_sessions); this file mirrors it
-- into the repo record.
ALTER TABLE objection_training_sessions
  ADD COLUMN IF NOT EXISTS scenario_snapshot jsonb;
