-- m249-commission-deposit-tracking.sql
--
-- The LEDGER tracks the money AFTER the deal closes: the brokerage RECEIVES the commission deposit at
-- the closing table, then DISBURSES the agent's split. CLOSE freezes the amount (close ≠ paid); these
-- columns track the post-close money movement (deposit received → disbursed/paid).
alter table commissions
  add column if not exists deposit_received_at timestamptz,
  add column if not exists deposit_received_by text;

comment on column commissions.deposit_received_at is
  'When the brokerage received the commission deposit at closing (post-close money tracking). NULL until received. Disbursement (status=paid) normally follows this for CDA-enforced brokerages.';
