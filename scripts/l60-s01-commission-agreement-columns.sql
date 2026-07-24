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

-- contract_signatures is the agent onboarding-contract ledger (ICA, team agreement,
-- policy ack, NAR ethics). A brokerage commission agreement is the same kind of
-- agent-signed onboarding document, so it joins the contract_type set.
alter table contract_signatures drop constraint if exists contract_signatures_contract_type_check;
alter table contract_signatures add constraint contract_signatures_contract_type_check
  check (contract_type = any (array[
    'independent_contractor','team_agreement','policy_acknowledgment','nar_code_of_ethics','commission_agreement'
  ]));
