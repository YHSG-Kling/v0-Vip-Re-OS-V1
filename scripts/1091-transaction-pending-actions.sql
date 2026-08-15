-- ===========================================================================
-- 1091-transaction-pending-actions.sql
--
-- Closing concierge orchestration layer. Where listing-health-scan stops
-- (pre-contract listings), the closing-orchestration cron picks up — every
-- transaction between offer accepted and closed gets watched every 6 hours.
-- Typed actions surface what the agent has to DO RIGHT NOW vs what's a
-- soft watch.
--
-- Why a new table instead of reusing transaction_tasks or
-- proactive_interventions:
--   - transaction_tasks is for arbitrary agent-driven tasks.
--   - proactive_interventions is brokerage-wide deal-health advisories.
--   - transaction_pending_actions is specifically for orchestration-engine-
--     generated deltas (appraisal not ordered, EM not received, lender
--     condition stale, walkthrough not scheduled, etc.) that the cron
--     produces, idempotently, with a fingerprint so re-runs don't dupe.
--
-- APPLIED VIA: supabase apply_migration "transaction_pending_actions"
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.transaction_pending_actions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id      uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  transaction_id    uuid NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  agent_id          uuid REFERENCES public.agents(id) ON DELETE SET NULL,

  action_type       text NOT NULL CHECK (action_type = ANY (ARRAY[
    'appraisal_not_ordered','inspection_window_closing','inspection_overdue',
    'em_not_received','lender_condition_stale','clear_to_close_late',
    'walkthrough_unscheduled','wire_instructions_missing','cda_missing',
    'title_commitment_late','financing_deadline_close','contract_followup_check'
  ]::text[])),

  severity          text NOT NULL DEFAULT 'medium' CHECK (severity = ANY (ARRAY['low','medium','high','urgent']::text[])),

  due_date          date,
  headline          text NOT NULL,
  detail            text,

  suggested_recipient text CHECK (suggested_recipient = ANY (ARRAY['buyer','seller','lender','inspector','title','escrow','co_agent','agent']::text[])),

  bucket_key        text NOT NULL,

  status            text NOT NULL DEFAULT 'open' CHECK (status = ANY (ARRAY['open','resolved','dismissed','superseded']::text[])),
  resolved_at       timestamptz,
  resolved_by       uuid,
  resolution_note   text,

  dispatched_email_id uuid,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_transaction_pending_actions_idem
  ON public.transaction_pending_actions(transaction_id, action_type, bucket_key)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_tpa_agent_open
  ON public.transaction_pending_actions(agent_id, status, severity, due_date)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_tpa_brokerage_open
  ON public.transaction_pending_actions(brokerage_id, status)
  WHERE status = 'open';
