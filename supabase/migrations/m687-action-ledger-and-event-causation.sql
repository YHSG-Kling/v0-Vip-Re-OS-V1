-- ── APPLIED LIVE 2026-10-02 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) — as m687a (table, CHECKs, RLS) + m687b (indexes incl. actor FK indexes, lifecycle_events causation) ──
--
-- m687 — ONE ACTION LEDGER + causation on kernel events (wave 97, lane 97A;
-- docs/architecture/OS-BLUEPRINT-GAP-MAP.md rows 11, 12, 17).
--
-- 1. public.agent_action_ledger — one row per external action an agent / manager / automation
--    takes (email, SMS, direct mail today; any provider call with side effects tomorrow), and per
--    decision NOT to act (wait / do_nothing → status 'skipped'). Writer: lib/kernel/action-ledger.ts
--    (claimAction / settleAction / recordNonAction), wired at lib/providers/dispatch.ts.
--    Reader: app/actions/flight-recorder.ts getEntityCausalChain.
--    · idempotency_key UNIQUE (NULLs allowed — a send with no cycle is recorded, not de-duplicated):
--      the 23505 loser re-reads the winner instead of acting twice.
--    · NO foreign keys on purpose: an audit ledger outlives the rows it describes (a deleted
--      contact's sends are still the brokerage's record), and causation_id may point at an event
--      that a retention sweep removed. Soft links, indexed.
--    · Writes are service-role only (no INSERT/UPDATE policy): the session client cannot forge a row.
-- 2. public.lifecycle_events.causation_id / correlation_id — nullable; written by
--    lib/kernel/emit.ts emitKernelEvent from the scope lib/kernel/causation.ts opens while the
--    kernel processes the parent (lib/kernel/notification-engine.ts processKernelEvent).
--
-- AFTER APPLYING: regenerate the vocabulary cache (lib/kernel/check-vocabularies.ts via
-- scripts/generate-*.ts) — this adds three CHECKs — and the schema snapshot / LIVE_TABLES.

CREATE TABLE IF NOT EXISTS public.agent_action_ledger (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id       uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  action             text NOT NULL,
  channel            text,
  actor_type         text NOT NULL DEFAULT 'system',
  actor_user_id      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  actor_agent_id     uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  actor_manager_key  text,
  subject_type       text NOT NULL,
  subject_id         uuid,
  subject_ref        text,
  reason_code        text NOT NULL DEFAULT 'UNSPECIFIED',
  reason_detail      text,
  idempotency_key    text,
  status             text NOT NULL DEFAULT 'proposed',
  outcome            text,
  provider           text,
  provider_ref       text,
  cost_usd           numeric(12,6),
  attempts           integer NOT NULL DEFAULT 1,
  risk_class         text,
  system_source      text,
  causation_id       uuid,
  correlation_id     uuid,
  error              text,
  detail             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  settled_at         timestamptz,
  CONSTRAINT agent_action_ledger_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT agent_action_ledger_status_check
    CHECK (status IN ('proposed', 'executed', 'failed', 'unknown', 'skipped')),
  CONSTRAINT agent_action_ledger_actor_type_check
    CHECK (actor_type IN ('manager', 'user', 'agent', 'system')),
  CONSTRAINT agent_action_ledger_reason_code_check
    CHECK (reason_code IN (
      'SELLER_FOLLOWUP_INTENT_INCREASE', 'BUYER_PROPERTY_MATCH', 'TRANSACTION_DEADLINE',
      'TRANSACTION_MILESTONE', 'AGENT_SLA_BREACH', 'PROPERTY_VALUE_CHANGE', 'LEAD_FIRST_RESPONSE',
      'CAMPAIGN_STEP', 'LIFETIME_TOUCH', 'CONTACT_WELCOME', 'COMPLIANCE_NOTICE', 'HUMAN_REQUESTED', 'WAIT_COOLDOWN',
      'NO_ACTION_NEEDED', 'UNSPECIFIED')),
  CONSTRAINT agent_action_ledger_action_format_check
    CHECK (action ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  CONSTRAINT agent_action_ledger_attempts_check CHECK (attempts >= 1)
);

CREATE INDEX IF NOT EXISTS idx_aal_brokerage_subject
  ON public.agent_action_ledger (brokerage_id, subject_type, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aal_causation
  ON public.agent_action_ledger (causation_id) WHERE causation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aal_correlation
  ON public.agent_action_ledger (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aal_unknown
  ON public.agent_action_ledger (brokerage_id, created_at) WHERE status = 'unknown';
CREATE INDEX IF NOT EXISTS idx_aal_actor_user
  ON public.agent_action_ledger (actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aal_actor_agent
  ON public.agent_action_ledger (actor_agent_id) WHERE actor_agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aal_provider_ref
  ON public.agent_action_ledger (provider_ref) WHERE provider_ref IS NOT NULL;

ALTER TABLE public.agent_action_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_action_ledger_select ON public.agent_action_ledger;
CREATE POLICY agent_action_ledger_select ON public.agent_action_ledger
  FOR SELECT TO authenticated
  USING (is_platform_admin() OR has_brokerage_access(brokerage_id));

COMMENT ON TABLE public.agent_action_ledger IS
  'One row per external action (and per wait/do_nothing decision) an agent, manager or automation takes. Writer lib/kernel/action-ledger.ts; reader app/actions/flight-recorder.ts. m687.';

-- ── causation on kernel events ──
ALTER TABLE public.lifecycle_events
  ADD COLUMN IF NOT EXISTS causation_id   uuid,
  ADD COLUMN IF NOT EXISTS correlation_id uuid;

CREATE INDEX IF NOT EXISTS idx_le_causation
  ON public.lifecycle_events (causation_id) WHERE causation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_le_correlation
  ON public.lifecycle_events (correlation_id) WHERE correlation_id IS NOT NULL;

COMMENT ON COLUMN public.lifecycle_events.causation_id IS
  'The lifecycle_events.id whose processing emitted this event (lib/kernel/causation.ts). NULL at a chain root. m687.';
COMMENT ON COLUMN public.lifecycle_events.correlation_id IS
  'The chain root every descendant inherits. NULL at the root itself (query id = X OR correlation_id = X). m687.';
