-- ── APPLIED LIVE 2026-10-07 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m729 — OS HEALTH & SELF-HEALING: the ledger's WHY gains OS_HEALTH_RECOVERY (wave 108, lane 108C).
-- Owner: "Cron Manager = operational-health coordinator … recovery policy transient→retry, rate
-- limit→backoff, provider failure→failover, stuck workflow→resume, data conflict→Data Steward,
-- compliance→Compliance Manager, financial discrepancy→Finance Manager + HALT, unknown→human."
--
-- Every recovery / route / halt / escalation the OS health supervisor (lib/kernel/os-health.ts) takes
-- is ledgered through withActionLedger (LAW 5). No existing reason code is that WHY, so the supervisor
-- would otherwise record UNSPECIFIED (a finding). This adds ONE code — additive widening only — and
-- restates the full list (the latest defining migration is the definer the proofs read). Mirrored in
-- ACTION_REASON_CODES (lib/kernel/action-ledger.ts).
--
-- SUPERSET NOTE FOR THE INTEGRATOR: any other wave-108 lane that widens this CHECK restates the list
-- without this code — the HIGHEST-numbered migration must carry the union.
--
-- Until applied: the ledger's own 23514 fallback records the row as UNSPECIFIED with
-- "[intended OS_HEALTH_RECOVERY; CHECK not widened]" in reason_detail — nothing is lost.
--
-- No table, column or index changes. The financial-writer kill switch is a tenant POLICY key
-- (brokerage_settings.settings.financial_writer_halts — lib/kernel/tenant-policy.ts), not a column.
--
-- Apply in ONE part (a single constraint swap, NOT VALID then VALIDATE — the m693 / m710 form).
-- AFTER APPLYING: regenerate the vocabulary cache (scripts/check-vocabularies.ts) — agent_action_ledger.reason_code.

ALTER TABLE public.agent_action_ledger DROP CONSTRAINT IF EXISTS agent_action_ledger_reason_code_check;
ALTER TABLE public.agent_action_ledger ADD CONSTRAINT agent_action_ledger_reason_code_check
  CHECK (reason_code IN (
    'SELLER_FOLLOWUP_INTENT_INCREASE', 'BUYER_PROPERTY_MATCH', 'TRANSACTION_DEADLINE',
    'TRANSACTION_MILESTONE', 'AGENT_SLA_BREACH', 'PROPERTY_VALUE_CHANGE', 'LEAD_FIRST_RESPONSE',
    'CAMPAIGN_STEP', 'LIFETIME_TOUCH', 'CONTACT_WELCOME', 'COMPLIANCE_NOTICE', 'HUMAN_REQUESTED',
    'SCHEDULED_CONTENT_PUBLISH', 'SUBSCRIPTION_LIFECYCLE',
    'NURTURE_TOUCH', 'CONVERSATION_RESPONSE', 'SERVICE_NOTICE', 'STAFF_ALERT',
    'WAIT_COOLDOWN', 'NO_ACTION_NEEDED', 'LEARNED_IMPROVEMENT', 'MISSION_LIFECYCLE',
    'OS_HEALTH_RECOVERY', 'UNSPECIFIED')) NOT VALID;
ALTER TABLE public.agent_action_ledger VALIDATE CONSTRAINT agent_action_ledger_reason_code_check;
