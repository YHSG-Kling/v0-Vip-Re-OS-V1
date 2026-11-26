-- scripts/L60-S04-retire-vestigial-workflow-engine.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- RETIRE THE VESTIGIAL WORKFLOW ENGINE A (workflow-orchestration drift).
-- Two workflow engines existed: Engine A (lib/orchestrator/workflow-engine.ts,
-- class WorkflowOrchestrator) over these three tables, and Engine B
-- (lib/workflow-orchestrator, workflow_runs/workflow_run_steps) which every real
-- business chain (ISA appointment prep, listing-appt copilot, compliance
-- auto-create) actually runs on. Engine A had NO live trigger — triggerWorkflow/
-- executeWorkflow were never called by any business flow, so these tables were
-- never written (0 rows). Its only surfaces were a retry cron (re-running configs
-- that never existed) and the "Workflow Monitor" (repointed to workflow_runs).
-- The engine, its cron, and the index export are removed in the same change; the
-- two readers were repointed (monitor → workflow_runs; multi-persona.executeWorkflow
-- → workflow_automations, which also fixes a table-mismatch bug). Dependency-closed
-- (only internal FKs), 0 rows, so this drop is data-safe.

DROP TABLE IF EXISTS workflow_retries;         -- FK → workflow_executions
DROP TABLE IF EXISTS workflow_step_executions; -- FK → workflow_executions
DROP TABLE IF EXISTS workflow_executions;
