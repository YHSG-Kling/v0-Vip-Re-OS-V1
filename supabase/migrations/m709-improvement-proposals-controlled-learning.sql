-- ── APPLIED LIVE 2026-10-05 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m709 — CONTROLLED LEARNING: the ONE proposal object (wave 104, lane 104C; owner scope 106
-- "propose → replay/experiment → promote under explicit authority").
--
-- SURVIVORS EVALUATED FOR "PROPOSAL" (LAW 1/2), neither fits:
--   connector_healing_proposals — PLATFORM-level (no brokerage_id), one connector's failure signature
--     → a patch proposal applied by superadmin (applied_by/applied_at); no tenant, no evaluation
--     result, no authority rung, no policy version. Extending it would put tenant learning under a
--     platform-only RLS and a connector vocabulary.
--   strategy_recommendations — a PER-DEAL offer recommendation (contact/listing/offer, price,
--     earnest, contingencies; status pending|accepted|modified|rejected) that an agent acts on; not
--     a change to how the OS itself decides.
-- So this table is NEW: one row per proposed change to the OS's own operating behaviour, carrying
-- the whole lifecycle PROPOSED → EVALUATED → APPROVED/REJECTED → PROMOTED → ROLLED_BACK. The
-- state machine and every writer live in lib/kernel/improvement-proposals.ts; promotion of a policy
-- happens ONLY through the key's survivor writer → appendTenantPolicyVersion (policy_version_ref
-- is the version it wrote), rollback re-applies the previous value the same way.
--
-- Apply in TWO parts (wave 98 rule): PART A (table + CHECKs + RLS), PART B (indexes, reason code).
-- AFTER APPLYING: regenerate scripts/schema-snapshot.ts, scripts/schema-fk-map.ts,
-- scripts/live-tables.ts and scripts/check-vocabularies.ts (two new CHECK vocabularies + one new
-- reason code), and restamp this header's line 1 (one provenance line, dated).

-- ══════════════════════════════ PART A — table, CHECKs, RLS ══════════════════════════════

CREATE TABLE IF NOT EXISTS public.improvement_proposals (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id                uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  -- what kind of thing changes: a tenant policy key, a system prompt, a copy variant, a predictor threshold
  subject_kind                text NOT NULL,
  -- the key inside that kind: policy key / source_system / sequence_ab:<sequence id> / predictor:<name>
  subject_key                 text NOT NULL,
  -- which learner wrote it (lib/kernel/improvement-proposals.ts PROPOSERS)
  proposer                    text NOT NULL,
  proposed_change             jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- [{kind, id|ref, ...}] — the rows the proposal rests on (arm results, feedback log, calibration log)
  evidence_refs               jsonb NOT NULL DEFAULT '[]'::jsonb,
  status                      text NOT NULL DEFAULT 'PROPOSED',
  -- {evaluator, verdict, score, why, detail} written by the deterministic evaluator; promotion detail rides here too
  evaluation                  jsonb,
  evaluated_at                timestamptz,
  -- the authority-ladder rung (lib/ai-isa/persona-tool-policy.ts AuthorityLevel 0-6) a NON-human promoter needs; 6 = human only
  authority_required          smallint NOT NULL DEFAULT 6,
  decided_by                  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  decided_at                  timestamptz,
  decision_reason             text,
  -- policy_key@version the promotion wrote (tenant_policy_versions), m700 spelling
  policy_version_ref          text,
  promoted_at                 timestamptz,
  rolled_back_at              timestamptz,
  rollback_policy_version_ref text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT improvement_proposals_subject_kind_check
    CHECK (subject_kind IN ('policy', 'prompt', 'variant', 'threshold')),
  CONSTRAINT improvement_proposals_status_check
    CHECK (status IN ('PROPOSED', 'EVALUATED', 'APPROVED', 'REJECTED', 'PROMOTED', 'ROLLED_BACK')),
  CONSTRAINT improvement_proposals_proposer_check
    CHECK (proposer IN ('copy_learning', 'predictor_learning', 'prompt_calibrator', 'outcome_autopsy', 'human')),
  CONSTRAINT improvement_proposals_authority_check
    CHECK (authority_required BETWEEN 0 AND 6),
  -- a PROMOTED row names the version it wrote; a ROLLED_BACK row names the one that undid it
  CONSTRAINT improvement_proposals_promotion_evidence_check
    CHECK (status <> 'PROMOTED' OR promoted_at IS NOT NULL),
  CONSTRAINT improvement_proposals_rollback_evidence_check
    CHECK (status <> 'ROLLED_BACK' OR rolled_back_at IS NOT NULL)
);

ALTER TABLE public.improvement_proposals ENABLE ROW LEVEL SECURITY;

-- tenant-scoped READ; every write is the service role through the kernel service
REVOKE INSERT, UPDATE, DELETE ON public.improvement_proposals FROM anon, authenticated;

DROP POLICY IF EXISTS improvement_proposals_select ON public.improvement_proposals;
CREATE POLICY improvement_proposals_select ON public.improvement_proposals
  FOR SELECT TO authenticated
  USING (is_platform_admin() OR has_brokerage_access(brokerage_id));

COMMENT ON TABLE public.improvement_proposals IS
  'Controlled learning (wave 104, m709): one row per proposed change to the OS''s own operating behaviour — PROPOSED → EVALUATED (replay / experiment arms, deterministic) → APPROVED/REJECTED (authority ladder + autonomy gate; a human for owner-level) → PROMOTED (through the survivor writer → tenant_policy_versions) → ROLLED_BACK. Writers: lib/kernel/improvement-proposals.ts only.';

-- ══════════════════════════════ PART B — indexes, reason code ══════════════════════════════

CREATE INDEX IF NOT EXISTS idx_improvement_proposals_tenant_status
  ON public.improvement_proposals (brokerage_id, status, created_at DESC);

-- one OPEN proposal per subject per tenant (a learner re-proposing the same change finds the open row)
CREATE UNIQUE INDEX IF NOT EXISTS uq_improvement_proposals_open_subject
  ON public.improvement_proposals (brokerage_id, subject_kind, subject_key)
  WHERE status IN ('PROPOSED', 'EVALUATED', 'APPROVED');

-- The ledger WHY for a promotion / rollback the learning loop itself initiated (a human's is
-- HUMAN_REQUESTED). Mirrors lib/kernel/action-ledger.ts ACTION_REASON_CODES (test:check-vocabulary).
ALTER TABLE public.agent_action_ledger DROP CONSTRAINT IF EXISTS agent_action_ledger_reason_code_check;
ALTER TABLE public.agent_action_ledger ADD CONSTRAINT agent_action_ledger_reason_code_check
  CHECK (reason_code IN (
    'SELLER_FOLLOWUP_INTENT_INCREASE', 'BUYER_PROPERTY_MATCH', 'TRANSACTION_DEADLINE',
    'TRANSACTION_MILESTONE', 'AGENT_SLA_BREACH', 'PROPERTY_VALUE_CHANGE', 'LEAD_FIRST_RESPONSE',
    'CAMPAIGN_STEP', 'LIFETIME_TOUCH', 'CONTACT_WELCOME', 'COMPLIANCE_NOTICE', 'HUMAN_REQUESTED',
    'SCHEDULED_CONTENT_PUBLISH', 'SUBSCRIPTION_LIFECYCLE',
    'NURTURE_TOUCH', 'CONVERSATION_RESPONSE', 'SERVICE_NOTICE', 'STAFF_ALERT',
    'WAIT_COOLDOWN', 'NO_ACTION_NEEDED', 'LEARNED_IMPROVEMENT', 'UNSPECIFIED')) NOT VALID;
ALTER TABLE public.agent_action_ledger VALIDATE CONSTRAINT agent_action_ledger_reason_code_check;
