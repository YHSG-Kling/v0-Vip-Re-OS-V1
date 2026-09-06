-- scripts/l60-s01-commission-agreement-columns.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- COMMISSION AGREEMENT ON THE AGENT PROFILE — the contract_signatures ledger is
-- already agent-keyed (agent_id, contract_type, provider_envelope_id,
-- document_url, esign_status) and is the home for a signed agent commission
-- agreement. These two nullable columns let a commission-agreement row remember
-- WHICH uploaded brokerage form was used (form_id → brokerage_forms) and the
-- values the admin filled in (field_values), so the record is reconstructable
-- before/without a provider envelope. Both nullable + IF NOT EXISTS — non-breaking
-- for every existing contract_signatures reader (transaction e-sign, license.ts,
-- finalize-packet).
alter table contract_signatures add column if not exists form_id uuid;
alter table contract_signatures add column if not exists field_values jsonb;

-- contract_signatures is a SHARED ledger with two writers, so the contract_type
-- CHECK must enumerate BOTH sets (recreating it with only one set would reject the
-- other writer's sends):
--   1. Agent onboarding contracts (ICA, team agreement, policy ack, NAR ethics) —
--      app/actions/onboarding/license.ts. A brokerage commission agreement is the
--      same kind of agent-signed onboarding document, so it joins this set.
--   2. Transaction document e-sign — app/actions/transaction-document-signatures.ts
--      writes contract_type = docType from lib/documents/signable-doc-types.ts
--      (SIGNABLE_DOC_TYPES). Those values MUST be allowed too.
alter table contract_signatures drop constraint if exists contract_signatures_contract_type_check;
alter table contract_signatures add constraint contract_signatures_contract_type_check
  check (contract_type = any (array[
    -- onboarding contracts (+ commission_agreement, new)
    'independent_contractor','team_agreement','policy_acknowledgment','nar_code_of_ethics','commission_agreement',
    -- transaction documents (SIGNABLE_DOC_TYPES)
    'purchase_agreement','contract','addendum','amendment','listing_agreement',
    'buyer_representation_agreement','disclosure','escrow_instructions','counter_offer','acceptance'
  ]));
