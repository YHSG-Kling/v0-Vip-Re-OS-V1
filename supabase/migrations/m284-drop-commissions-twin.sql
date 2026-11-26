-- m284 — Commission ledger KEEP-ONE, final step: drop the `commissions` twin.
--
-- Context: the OS carried two commission ledgers. `agent_commissions` (25 code
-- consumers, full dispute/approval lifecycle, QuickBooks export columns) is the
-- keeper. `commissions` (7 consumers, no lifecycle) is the twin. m283 made the
-- keeper a strict superset by porting the twin's 7 exclusive columns
-- (total_fees, net_to_agent, net_to_brokerage, cap_applied, calculation_version,
-- deposit_received_at, deposit_received_by). All 7 consumers were repointed in
-- the same PR, with the column translations commissions.paid_date -> paid_at and
-- commissions.split_percentage -> agent_split_percent.
--
-- This migration closes the loop: backfill any twin rows the keeper is missing,
-- move the three dependents off the twin, then drop it.
--
-- Dependents investigated before dropping (CASCADE deliberately NOT used):
--   1. financial_dashboard_view  — zero code consumers; rewritten against the keeper
--      so the aggregate stays live for anyone querying the DB directly.
--   2. commission_distributions.commission_id — FK only, zero code references, 0 rows.
--   3. earnings_history.commission_id — FK only, already documented in
--      app/actions/financials.ts as a writer-less twin, 0 rows.
-- Both dependent tables being empty means repointing the FKs cannot orphan a row.

-- 1. Backfill: any twin row whose transaction has no keeper row.
--    agent_commission and brokerage_commission are GENERATED columns on the
--    keeper (gross_commission * agent_split_percent / 100) and must be omitted.
INSERT INTO agent_commissions (
  id, brokerage_id, agent_id, transaction_id, gross_commission,
  agent_split_percent, status, paid_at, total_fees, net_to_agent,
  net_to_brokerage, cap_applied, calculation_version,
  deposit_received_at, deposit_received_by, created_at
)
SELECT
  c.id, c.brokerage_id, c.agent_id, c.transaction_id, c.gross_commission,
  c.split_percentage, c.status, c.paid_date::timestamptz, c.total_fees,
  c.net_to_agent, c.net_to_brokerage, c.cap_applied, c.calculation_version,
  c.deposit_received_at, c.deposit_received_by, c.created_at
FROM commissions c
WHERE NOT EXISTS (SELECT 1 FROM agent_commissions a WHERE a.id = c.id)
ON CONFLICT (id) DO NOTHING;

-- 2. Rewrite the dependent view against the keeper.
DROP VIEW IF EXISTS financial_dashboard_view;
CREATE VIEW financial_dashboard_view AS
SELECT
  agent_id,
  brokerage_id,
  count(id) AS total_transactions,
  sum(gross_commission) AS total_gross_commission,
  sum(net_to_agent) AS total_agent_net,
  sum(net_to_brokerage) AS total_brokerage_net,
  sum(total_fees) AS total_fees,
  sum(CASE WHEN date_trunc('month', created_at) = date_trunc('month', now())
           THEN net_to_agent ELSE 0::numeric END) AS mtd_agent_net,
  sum(CASE WHEN date_trunc('year', created_at) = date_trunc('year', now())
           THEN net_to_agent ELSE 0::numeric END) AS ytd_agent_net,
  sum(CASE WHEN date_trunc('month', created_at) = date_trunc('month', now())
           THEN gross_commission ELSE 0::numeric END) AS mtd_gross_commission
FROM agent_commissions
WHERE status = 'paid'
GROUP BY agent_id, brokerage_id;

-- 3. Repoint the two foreign keys onto the keeper.
ALTER TABLE commission_distributions
  DROP CONSTRAINT IF EXISTS commission_distributions_commission_id_fkey;
ALTER TABLE commission_distributions
  ADD CONSTRAINT commission_distributions_commission_id_fkey
  FOREIGN KEY (commission_id) REFERENCES agent_commissions(id) ON DELETE CASCADE;

ALTER TABLE earnings_history
  DROP CONSTRAINT IF EXISTS earnings_history_commission_id_fkey;
ALTER TABLE earnings_history
  ADD CONSTRAINT earnings_history_commission_id_fkey
  FOREIGN KEY (commission_id) REFERENCES agent_commissions(id) ON DELETE CASCADE;

-- 4. Drop the twin. One commission ledger from here on.
DROP TABLE IF EXISTS commissions;
