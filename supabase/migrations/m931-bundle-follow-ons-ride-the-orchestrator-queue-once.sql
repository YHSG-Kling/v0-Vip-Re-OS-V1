-- ── APPLIED LIVE 2026-11-16 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 153, lane 153I ── read back: unique index orchestrator_tasks_bundle_follow_on_key ON ((payload->>'idempotency_key')) WHERE task_type = 'bundle_follow_on'
--
-- m931 — a persisted campaign-bundle follow-on is written ONCE (convergence row 71; owner rulings 14 + 17).
--
-- WHAT CHANGED IN CODE (lane 153I). lib/direct-mail/orchestrate-bundle-send.ts no longer fires every bundle item in one
-- synchronous pass. The FIRST item goes on the sender's click; every later item is persisted as a FOLLOW-ON on the
-- campaign orchestrator's own queue, public.orchestrator_tasks (TABLE_MANAGER → campaign_orchestrator), task_type
-- 'bundle_follow_on', only after its origin item reached a terminal state. The existing drain
-- (app/api/cron/queue-drain/route.ts drainOrchestratorTasks, every 5 minutes) hands each due row to
-- executeBundleFollowOnTask, which claims it (pending → running, counted), asks the Contact-engagement arbiter for a
-- person-facing piece, sends through the channel orchestrator (lib/providers/dispatch.ts gates unchanged) and settles.
--
-- WHY NO NEW TABLE (orphan doctrine §1 — survivors audited at 34124d98; live 2026-11-14: orchestrator_tasks 0 rows,
-- campaign_bundles 0, campaign_bundle_items 0, campaign_bundle_dispatches 0):
--   · orchestrator_tasks IS the campaign orchestrator's cron-drained task queue: brokerage_id, task_type, payload jsonb,
--     scheduled_for, status CHECK (pending | running | completed | failed | cancelled), attempts, last_error, executed_at.
--     Every field a follow-on needs exists; the payload carries origin item, bundle, dispatch, audience ids, dependency,
--     timing policy, governance planes and expected evidence (ids and channel keys only — never a body or contact PII).
--   · manager_completions (m904) is an OBLIGATION ledger closed by evidence under a supervisor that redrives only
--     inbound_response and closes a follow_up holding a decision — it would close or escalate executable work it cannot run.
--   · sequence_enrollments + campaign_sequence_steps (wave-152 Decision 3's bundle_item_id proposal) would need a mirror
--     campaign_sequences row per bundle — a second copy of the item order that shows in the sequence builder and is
--     dispatched by step-channel adapters, not the bundle's preset orchestrators.
--   · campaign_bundle_dispatches.channel_outcomes is a per-dispatch jsonb blob keyed by channel — not claimable, not
--     indexable, and two items on one channel overwrite each other (lane 152I rejected it as a parallel queue).
--   · the stable ITEM identity is campaign_bundle_items.id — app/actions/campaign-bundles.ts upsertCampaignBundle now keeps it
--     across edits by m160's natural key UNIQUE (bundle_id, channel, preset_id); no column is added.
--
-- WHAT THIS ADDS. orchestrator_tasks has no uniqueness beyond its pkey, so the idempotency key the writer stamps
-- (payload->>'idempotency_key' = 'bundle_follow_on:<dispatch id>:<item id>') is guarded today only by the writer's pre-read.
-- This partial UNIQUE index makes a racing second persist of the same follow-on a 23505, which the writer reads as
-- "already persisted" (persistFollowOnRecord). It touches only rows of task_type 'bundle_follow_on'; the existing
-- 'publish_scheduled_post' rows (lib/services/social-publishing.service.ts) are unaffected.
--
-- PRE-CHECK (read-only; expected 0 rows):
--   SELECT payload->>'idempotency_key' AS k, count(*) FROM public.orchestrator_tasks
--    WHERE task_type = 'bundle_follow_on' GROUP BY 1 HAVING count(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS orchestrator_tasks_bundle_follow_on_key
  ON public.orchestrator_tasks ((payload->>'idempotency_key'))
  WHERE task_type = 'bundle_follow_on';

COMMENT ON INDEX public.orchestrator_tasks_bundle_follow_on_key IS
  'm931 (wave 153, lane 153I — row 71): one persisted campaign-bundle follow-on per (dispatch, item). Written by lib/direct-mail/orchestrate-bundle-send.ts persistFollowOnRecord (23505 = already persisted); drained by app/api/cron/queue-drain/route.ts → executeBundleFollowOnTask.';

-- VERIFY (read-only, after applying):
--   SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'orchestrator_tasks_bundle_follow_on_key';
--     -- 1 row, ... USING btree (((payload ->> 'idempotency_key'::text))) WHERE (task_type = 'bundle_follow_on'::text)
--
-- ROLLBACK (owner SQL — DROP INDEX is owner-only; listed in docs/operations/OWNER-SQL.md § O. Wave 153):
--   DROP INDEX IF EXISTS public.orchestrator_tasks_bundle_follow_on_key;
-- The code keeps its pre-read either way; only the race guard goes.
