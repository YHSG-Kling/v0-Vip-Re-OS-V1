-- ── APPLIED LIVE 2026-10-05 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m700 — wave 102, lane 102D: the wave-101 still-open remainders, two additive parts.
--
-- PART 1 — WHICH POLICY PERMITTED (agent_action_ledger.policy_ref; gap map rows 11/17/21; LAW 5).
--   A ledger row names the tenant policy it ran under as `policy_key@version` — the key grammar is
--   m696's tenant_policy_versions.policy_key (lib/kernel/tenant-policy.ts parsePolicyKey, now also
--   `assignment_rule:<id>` and `<table>_cadence_policy:<scope_type>:<scope_id>`), the version is
--   lib/kernel/tenant-policy.ts currentPolicyVersion (0 = never changed through the versioned writer,
--   `unknown` = the version read was refused — never a guessed number). Writer: lib/kernel/action-ledger.ts
--   insertLedgerRow from ActionContext.policyKey (dispatch's autonomy posture, the sequence A/B's
--   `experiments`, the AI tool mount's `authority_level:ai_isa`). Reader: app/actions/flight-recorder.ts
--   → app/dashboard/admin/ai-audit ("permitted by <ref>"). Until applied the writer gets PGRST204 on
--   the column, re-writes the row WITHOUT it and carries the ref in detail.policy_ref; the recorder
--   falls back to the base columns. Nothing degrades to "unledgered" for this column.
--
-- PART 2 — PER-ARM OUTCOMES ON agent_outcome_evaluations (101B still-open; LAW 2: extend the ONE
--   evaluation table, no second one). The table held Anthropic rubric grades of a managed-agent
--   session (NOT NULL session + outcome id). A second EVALUATOR now writes the same row: an
--   attributed real-world outcome (reply / appointment / contract / closed — lib/intelligence/roi-ledger.ts
--   attributeOutcomesToLedger, last touch) that landed on a ledger action carrying
--   detail.experiment = { key, arm } (lib/kernel/experiments.ts experimentLedgerDetail). Writer:
--   lib/agents/outcomes.ts recordOutcomeEvaluation (the one inserter, which the Anthropic webhook now
--   calls too), driven by lib/intelligence/roi-ledger.ts recordExperimentArmOutcomes on the weekly
--   source-conversion-learning cron. Reader: lib/campaign-sequences/copy-learning-conductor.ts
--   loadExperimentArmResults — the winner gate's reply numerator. `evaluator` tells the two apart;
--   the row-shape CHECK makes each evaluator's columns mandatory for it. The manager trust readers
--   (app/actions/admin/manager-evals.ts) already exclude session-less rows.
--
-- Apply in TWO parts (wave 98 rule): PART A (columns + CHECKs), then PART B (indexes + FK + unique).
-- AFTER APPLYING: regenerate the vocabulary cache (two new CHECKs), the schema snapshot, and the FK
-- map (one new FK: agent_outcome_evaluations.ledger_action_id → agent_action_ledger.id).

-- ══════════════════════════════ PART A — columns, CHECKs ══════════════════════════════

-- 1. agent_action_ledger.policy_ref
ALTER TABLE public.agent_action_ledger
  ADD COLUMN IF NOT EXISTS policy_ref text;

ALTER TABLE public.agent_action_ledger
  DROP CONSTRAINT IF EXISTS agent_action_ledger_policy_ref_format_check;
ALTER TABLE public.agent_action_ledger
  ADD CONSTRAINT agent_action_ledger_policy_ref_format_check
  CHECK (policy_ref IS NULL OR policy_ref ~ '^[a-z][a-z0-9_]*(:[a-z0-9_-]+)*@([0-9]+|unknown)$');

COMMENT ON COLUMN public.agent_action_ledger.policy_ref IS
  'Which tenant policy permitted this action: policy_key@version (m696 key grammar; version from lib/kernel/tenant-policy.ts currentPolicyVersion, "unknown" when that read was refused). Writer lib/kernel/action-ledger.ts; reader app/actions/flight-recorder.ts. m700.';

-- 2. agent_outcome_evaluations — a second evaluator on the same row.
ALTER TABLE public.agent_outcome_evaluations
  ALTER COLUMN managed_agent_session_id DROP NOT NULL,
  ALTER COLUMN anthropic_outcome_id DROP NOT NULL;

ALTER TABLE public.agent_outcome_evaluations
  ADD COLUMN IF NOT EXISTS evaluator        text NOT NULL DEFAULT 'anthropic_rubric',
  ADD COLUMN IF NOT EXISTS ledger_action_id uuid,
  ADD COLUMN IF NOT EXISTS experiment_key   text,
  ADD COLUMN IF NOT EXISTS experiment_arm   text,
  ADD COLUMN IF NOT EXISTS outcome_ref      text,
  ADD COLUMN IF NOT EXISTS outcome_kind     text;

ALTER TABLE public.agent_outcome_evaluations
  DROP CONSTRAINT IF EXISTS agent_outcome_evaluations_evaluator_check;
ALTER TABLE public.agent_outcome_evaluations
  ADD CONSTRAINT agent_outcome_evaluations_evaluator_check
  CHECK (evaluator IN ('anthropic_rubric', 'ledger_attribution'));

ALTER TABLE public.agent_outcome_evaluations
  DROP CONSTRAINT IF EXISTS agent_outcome_evaluations_outcome_kind_check;
ALTER TABLE public.agent_outcome_evaluations
  ADD CONSTRAINT agent_outcome_evaluations_outcome_kind_check
  CHECK (outcome_kind IS NULL OR outcome_kind IN ('reply', 'appointment', 'contract', 'closed'));

-- Each evaluator's columns are mandatory FOR IT: a rubric row keeps the session + outcome id it
-- always had; an attribution row names the ledger action, the arm and the outcome it earned.
ALTER TABLE public.agent_outcome_evaluations
  DROP CONSTRAINT IF EXISTS agent_outcome_evaluations_evaluator_shape_check;
ALTER TABLE public.agent_outcome_evaluations
  ADD CONSTRAINT agent_outcome_evaluations_evaluator_shape_check
  CHECK (
    (evaluator = 'anthropic_rubric'
      AND managed_agent_session_id IS NOT NULL AND anthropic_outcome_id IS NOT NULL
      AND ledger_action_id IS NULL AND experiment_key IS NULL AND experiment_arm IS NULL AND outcome_ref IS NULL)
    OR
    (evaluator = 'ledger_attribution'
      AND ledger_action_id IS NOT NULL AND experiment_key IS NOT NULL AND experiment_arm IS NOT NULL
      AND outcome_ref IS NOT NULL AND outcome_kind IS NOT NULL
      AND managed_agent_session_id IS NULL AND anthropic_outcome_id IS NULL)
  );

COMMENT ON COLUMN public.agent_outcome_evaluations.evaluator IS
  'anthropic_rubric = Anthropic Managed Agents rubric grade of a session (app/api/webhooks/anthropic-agent); ledger_attribution = a real-world outcome attributed (last touch) to an experiment-arm ledger action (lib/intelligence/roi-ledger.ts recordExperimentArmOutcomes). One writer: lib/agents/outcomes.ts recordOutcomeEvaluation. m700.';

-- ══════════════════════════════ PART B — FK, unique, indexes ══════════════════════════════

ALTER TABLE public.agent_outcome_evaluations
  DROP CONSTRAINT IF EXISTS agent_outcome_evaluations_ledger_action_id_fkey;
ALTER TABLE public.agent_outcome_evaluations
  ADD CONSTRAINT agent_outcome_evaluations_ledger_action_id_fkey
  FOREIGN KEY (ledger_action_id) REFERENCES public.agent_action_ledger(id) ON DELETE CASCADE;

-- Idempotency of the attribution evaluator: one row per (arm action, outcome).
CREATE UNIQUE INDEX IF NOT EXISTS agent_outcome_evaluations_arm_outcome_key
  ON public.agent_outcome_evaluations (ledger_action_id, outcome_ref)
  WHERE evaluator = 'ledger_attribution';

-- The winner gate's read: this tenant, this experiment, grouped by arm.
CREATE INDEX IF NOT EXISTS idx_aoe_experiment_arm
  ON public.agent_outcome_evaluations (brokerage_id, experiment_key, experiment_arm)
  WHERE evaluator = 'ledger_attribution';

-- The recorder's "permitted by" lookups and the constitution's "actions under v3" question.
CREATE INDEX IF NOT EXISTS idx_aal_policy_ref
  ON public.agent_action_ledger (brokerage_id, policy_ref)
  WHERE policy_ref IS NOT NULL;
