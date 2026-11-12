-- ── APPLIED LIVE 2026-10-03 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
--
-- m691 — agent_action_ledger reason vocabulary gains SCHEDULED_CONTENT_PUBLISH (wave 98 integrator).
-- Lane 98B ledgered social publishing (lib/social/publisher.ts ledgerSocialPublish) and every row read
-- UNSPECIFIED because no m687 reason fit a scheduled post. Code vocabulary: lib/kernel/action-ledger.ts
-- ACTION_REASON_CODES (the two lists must agree — check-vocabulary-guard holds them together).
ALTER TABLE public.agent_action_ledger DROP CONSTRAINT IF EXISTS agent_action_ledger_reason_code_check;
ALTER TABLE public.agent_action_ledger ADD CONSTRAINT agent_action_ledger_reason_code_check
  CHECK (reason_code IN (
    'SELLER_FOLLOWUP_INTENT_INCREASE', 'BUYER_PROPERTY_MATCH', 'TRANSACTION_DEADLINE',
    'TRANSACTION_MILESTONE', 'AGENT_SLA_BREACH', 'PROPERTY_VALUE_CHANGE', 'LEAD_FIRST_RESPONSE',
    'CAMPAIGN_STEP', 'LIFETIME_TOUCH', 'CONTACT_WELCOME', 'COMPLIANCE_NOTICE', 'HUMAN_REQUESTED',
    'SCHEDULED_CONTENT_PUBLISH', 'WAIT_COOLDOWN', 'NO_ACTION_NEEDED', 'UNSPECIFIED'));
