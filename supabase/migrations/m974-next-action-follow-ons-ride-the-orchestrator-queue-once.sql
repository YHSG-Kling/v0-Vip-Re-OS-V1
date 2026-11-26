-- ── APPLIED LIVE 2026-11-18 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 154, lane 154H ── read back: unique index orchestrator_tasks_next_action_follow_on_key on ((payload ->> 'idempotency_key')) WHERE task_type = 'next_action_follow_on'
--
-- m974 — a persisted NEXT-ACTION follow-on is written ONCE (owner ruling R8; directive H8 "a retry must claim the same item").
--
-- WHAT CHANGED IN CODE (lane 154H). lib/ai-isa/followup-arbiter.ts persistNextActionFollowOn writes a follow-on of a next-action
-- decision (the lifetime anniversary first: lib/sphere/lifetime-touch-arbitration.ts) onto the campaign orchestrator's own queue,
-- public.orchestrator_tasks, task_type 'next_action_follow_on' — the m931 survivor, NO new table. The existing drain
-- (app/api/cron/queue-drain/route.ts drainOrchestratorTasks, every 5 minutes) routes each due row to its planner's executor
-- (executeLifetimeFollowOn), which claims it (pending → running, counted), re-reads the person and settles.
--
-- WHY NO NEW TABLE OR COLUMN: every H8 field rides the live columns (brokerage_id, task_type, status CHECK pending | running |
-- completed | failed | cancelled, scheduled_for = next evaluation, attempts, last_error, executed_at) and payload jsonb (source event
-- id / version, subject, actor, manager, trigger, waits_for, condition, expected evidence, dependencies, eligibility snapshot,
-- window, origin attribution, evaluations, recovery_waits, outcome). task_type has no CHECK, so the new spelling needs none.
--
-- WHAT THIS ADDS. The writer's idempotency key (payload->>'idempotency_key' =
-- 'next_action_follow_on:<brokerage>:<event type>:<event id>:v<version>:<subject type>:<subject id>:<trigger>') is otherwise guarded
-- only by its pre-read. This partial UNIQUE index makes a racing second persist of the same follow-on a 23505, which the writer
-- reads as "already persisted". It touches only task_type 'next_action_follow_on' rows; 'bundle_follow_on' (m931) and
-- 'publish_scheduled_post' rows are unaffected.
--
-- PRE-CHECK (read-only; expected 0 rows — the task type is new):
--   SELECT payload->>'idempotency_key' AS k, count(*) FROM public.orchestrator_tasks
--    WHERE task_type = 'next_action_follow_on' GROUP BY 1 HAVING count(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS orchestrator_tasks_next_action_follow_on_key
  ON public.orchestrator_tasks ((payload->>'idempotency_key'))
  WHERE task_type = 'next_action_follow_on';

COMMENT ON INDEX public.orchestrator_tasks_next_action_follow_on_key IS
  'm974 (wave 154, lane 154H — owner R8 / directive H8): one persisted next-action follow-on per (tenant, source event, version, subject, trigger). Written by lib/ai-isa/followup-arbiter.ts persistNextActionFollowOn (23505 = already persisted); drained by app/api/cron/queue-drain/route.ts → executeLifetimeFollowOn.';

-- VERIFY (read-only, after applying):
--   SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'orchestrator_tasks_next_action_follow_on_key';
--     -- 1 row, ... USING btree (((payload ->> 'idempotency_key'::text))) WHERE (task_type = 'next_action_follow_on'::text)
--
-- ROLLBACK (owner SQL — DROP INDEX is owner-only; listed in lane 154H notes, never run from a migration):
--   DROP INDEX IF EXISTS public.orchestrator_tasks_next_action_follow_on_key;
-- The code keeps its pre-read either way; only the race guard goes.
