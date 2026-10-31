-- ── APPLIED LIVE 2026-10-31 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 147, lane 147G ──
--
-- m904 — manager_completions: THE COMPLETION LEDGER (contract C14; owner rulings 13 + 14, 2026-10-31 — "the managers need
-- to make sure that arbiter completes not relying on crons to do so"; "self healing should handle the os not just the
-- connections").
--
-- WHAT A ROW IS. One obligation a manager's decision opened: WHAT must happen, WHICH registered manager owns it, by WHEN,
-- and WHICH evidence closes it (a decision, a provider's delivery outcome / acknowledgement, a person's action, a ticket's
-- resolution). Evidence is appended as it arrives (the inbound webhook, the provider status callback, the supervisor's
-- re-read of the survivor); the row closes only on evidence. A stall (no evidence by due) is detected by the supervision
-- loop the EVENT drives (lib/kernel/completion-tracking.ts superviseCompletion, scheduled by the durable timer
-- workflows/completion-watch-workflow.ts), remediated through the self-healing engine (lib/kernel/self-healing.ts
-- runDeclaredPlaybook — domain `completions`), and only what events missed is reconciled by the cron net
-- (reconcileOpenCompletions on the manager-signals tick), which stamps recovered_by = 'cron'.
--
-- WHY A NEW TABLE (orphan doctrine §1.2 — survivors audited at 4d527cc3 and live 2026-10-31; to_regclass is null, no
-- public table matches %complet% / %follow% / %obligation% / %commitment% / %supervis% / %outbox% / %manager_task% except
-- unrelated ones: agent_ce_completions, agent_step_completions, journey_task_completions, video_completion_tracking,
-- company_books_obligations):
--   · agent_action_ledger (m687) is the DECISION record: it settles when the action runs (executed / skipped / failed) and
--     carries no due time, no expected evidence and no closure; re-opening a settled row would break its idempotency and
--     the roi-ledger attribution that reads `status`. The completion POINTS AT the decision (decision_ledger_key).
--   · outcome_reconciliations is ONE stage (provider truth for a send — claimed vs reported) on six channels; a decision
--     that ends in a person, a ticket or "no response" never reaches it. The completion READS it as delivery evidence.
--   · manager_delegations (m712) is manager-to-MANAGER: a self-delegation is refused, the capability must be a catalogue
--     key the assignee owns, and every transition signals another manager. A decision the arbiter must see through is
--     not a delegation (CLAUDE.md §6 — one vocabulary per function).
--   · manager_signals is the BUS (open / consumed / expired, consumed on the 30-minute tick): no owner-of-record, no due,
--     no evidence. tasks / activities are a PERSON's work items; orchestrator_tasks is a cron-drained publish queue.
--
-- TENANCY. brokerage_id NOT NULL (FK, cascade). Written ONLY by the service client through lib/kernel/completion-tracking.ts
-- (writes revoked from anon / authenticated); tenant members read their own rows (has_brokerage_access), platform staff read
-- all (is_platform_admin). The row never stores a message body or contact PII — `context` holds ids and channel keys only.
--
-- AFTER APPLYING: regenerate scripts/schema-snapshot.ts, scripts/check-vocabularies.ts (six CHECKs), scripts/live-tables.ts
-- and scripts/schema-fk-map.ts (one FK) from live JSON; lane 147I adds TABLE_MANAGER.manager_completions = "cron_manager".

CREATE TABLE IF NOT EXISTS public.manager_completions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id         uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  kind                 text NOT NULL,
  owner_manager        text NOT NULL,
  subject_type         text NOT NULL,
  subject_id           uuid,
  subject_ref          text,
  source_ref           text NOT NULL,
  idempotency_key      text NOT NULL,
  what                 text NOT NULL,
  stage                text NOT NULL,
  expected_evidence    text[] NOT NULL DEFAULT '{}'::text[],
  evidence             jsonb NOT NULL DEFAULT '[]'::jsonb,
  status               text NOT NULL DEFAULT 'open',
  due_at               timestamptz NOT NULL,
  attempts             integer NOT NULL DEFAULT 0,
  last_attempt_at      timestamptz,
  detection            text,
  recovered_by         text,
  decision_ledger_key  text,
  provider_ref         text,
  context              jsonb NOT NULL DEFAULT '{}'::jsonb,
  closed_at            timestamptz,
  closed_by            text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT manager_completions_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT manager_completions_kind_check
    CHECK (kind IN ('inbound_response', 'outbound_delivery', 'follow_up', 'human_handoff', 'support_ticket')),
  CONSTRAINT manager_completions_owner_manager_check
    CHECK (owner_manager IN ('deal_coordinator', 'cron_manager', 'shopping_agent', 'listing_concierge', 'sphere_of_influence',
                             'campaign_orchestrator', 'asset_manager', 'ads_manager', 'ai_isa', 'data_steward',
                             'recruiting_manager', 'compliance_officer', 'finance_manager')),
  CONSTRAINT manager_completions_stage_check
    CHECK (stage IN ('awaiting_decision', 'awaiting_delivery', 'awaiting_human', 'awaiting_resolution', 'done')),
  CONSTRAINT manager_completions_status_check
    CHECK (status IN ('open', 'stalled', 'escalated', 'closed', 'cancelled')),
  CONSTRAINT manager_completions_detection_check
    CHECK (detection IS NULL OR detection IN ('stalled_decision', 'missing_provider_ack', 'broken_integration',
                                              'unresolved_ticket', 'failed_delivery', 'incomplete_follow_up')),
  CONSTRAINT manager_completions_recovered_by_check
    CHECK (recovered_by IS NULL OR recovered_by IN ('event', 'retry', 'workflow', 'cron')),
  CONSTRAINT manager_completions_attempts_check CHECK (attempts >= 0),
  CONSTRAINT manager_completions_closed_consistency
    CHECK ((status IN ('closed', 'cancelled')) = (closed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS manager_completions_open_due_idx
  ON public.manager_completions (brokerage_id, due_at)
  WHERE status IN ('open', 'stalled', 'escalated');
CREATE INDEX IF NOT EXISTS manager_completions_provider_ref_idx
  ON public.manager_completions (brokerage_id, provider_ref)
  WHERE provider_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS manager_completions_subject_idx
  ON public.manager_completions (brokerage_id, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS manager_completions_source_idx
  ON public.manager_completions (brokerage_id, source_ref);

ALTER TABLE public.manager_completions ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE ON public.manager_completions FROM anon, authenticated;

DROP POLICY IF EXISTS manager_completions_select ON public.manager_completions;
CREATE POLICY manager_completions_select ON public.manager_completions
  FOR SELECT TO authenticated
  USING (is_platform_admin() OR has_brokerage_access(brokerage_id));

COMMENT ON TABLE public.manager_completions IS
  'Contract C14 (wave 147, lane 147G): one obligation a manager decision opened — what, owner_manager (a MANAGERS key), due_at, expected_evidence — closed only by evidence (decision / delivery_outcome / provider_ack / human_action / ticket_resolution). Written ONLY by lib/kernel/completion-tracking.ts. A stall is detected by the event-driven supervisor (durable timer: workflows/completion-watch-workflow.ts) and remediated through lib/kernel/self-healing.ts (domain completions); the cron net stamps recovered_by = cron.';

-- VERIFY (read-only, after applying):
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.manager_completions'::regclass ORDER BY 1;   -- 9 incl. pkey + fk
--   SELECT polname FROM pg_policy WHERE polrelid = 'public.manager_completions'::regclass;                -- manager_completions_select
--   SELECT relrowsecurity FROM pg_class WHERE oid = 'public.manager_completions'::regclass;              -- true
--   SELECT count(*) FROM public.manager_completions;                                                      -- 0 on first apply
--
-- ROLLBACK (owner SQL editor): DROP TABLE public.manager_completions;
