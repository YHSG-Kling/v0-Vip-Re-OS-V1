-- ── APPLIED LIVE 2026-10-03 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
--
-- m693 — agent_action_ledger reason vocabulary: the UNIVERSAL set (wave 100A, OWNER LAW 2, CLAUDE.md §6).
-- Lane 100A mapped every other spelling of "why an autonomous action happened" (≈90 dispatch / voice /
-- portal / push systemSources, the NBA LeadTouchPlanCode, the ledger action families) onto
-- ACTION_REASON_CODES through ONE table (lib/kernel/action-ledger.ts REASON_CODE_MAP). Four WHYs had
-- no code and every such row read UNSPECIFIED:
--   NURTURE_TOUCH          the AI ISA's / lead plan's cadenced follow-up to a lead or contact
--   CONVERSATION_RESPONSE  answering the person's own message or request (inbound reply, AI chat tool, callback ask)
--   SERVICE_NOTICE         operational notice to a client / vendor / partner
--   STAFF_ALERT            an alert to the brokerage's own staff
-- Until this is applied the ledger records such a row as UNSPECIFIED with "[intended <CODE>; CHECK not
-- widened]" in reason_detail (lib/kernel/action-ledger.ts insertLedgerRow, the 23514 retry) — nothing is
-- dropped and no send fails closed on the vocabulary lag.
-- After applying: regenerate scripts/check-vocabularies.ts (scripts/generate-check-vocabularies.ts) so
-- check-vocabulary-guard holds code and CHECK together; test:action-ledger derives both sides.
--
-- Applies in TWO small parts (wave 98 rule). Part 1 swaps the constraint NOT VALID (no table scan);
-- part 2 validates it (a SHARE UPDATE EXCLUSIVE scan — reads and writes continue).

-- ── PART 1 ──
ALTER TABLE public.agent_action_ledger DROP CONSTRAINT IF EXISTS agent_action_ledger_reason_code_check;
ALTER TABLE public.agent_action_ledger ADD CONSTRAINT agent_action_ledger_reason_code_check
  CHECK (reason_code IN (
    'SELLER_FOLLOWUP_INTENT_INCREASE', 'BUYER_PROPERTY_MATCH', 'TRANSACTION_DEADLINE',
    'TRANSACTION_MILESTONE', 'AGENT_SLA_BREACH', 'PROPERTY_VALUE_CHANGE', 'LEAD_FIRST_RESPONSE',
    'CAMPAIGN_STEP', 'LIFETIME_TOUCH', 'CONTACT_WELCOME', 'COMPLIANCE_NOTICE', 'HUMAN_REQUESTED',
    'SCHEDULED_CONTENT_PUBLISH', 'SUBSCRIPTION_LIFECYCLE',
    'NURTURE_TOUCH', 'CONVERSATION_RESPONSE', 'SERVICE_NOTICE', 'STAFF_ALERT',
    'WAIT_COOLDOWN', 'NO_ACTION_NEEDED', 'UNSPECIFIED')) NOT VALID;

-- ── PART 2 ──
ALTER TABLE public.agent_action_ledger VALIDATE CONSTRAINT agent_action_ledger_reason_code_check;
