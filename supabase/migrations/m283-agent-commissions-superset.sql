-- m283 — KEEP-ONE step 1: make agent_commissions a SUPERSET of the duplicate
-- `commissions` ledger before repointing consumers.
--
-- The two tables are the same concept (one per-transaction agent commission
-- record). agent_commissions is the KEEPER — 25 consumers vs 7, and it alone
-- carries the dispute lifecycle, approval, payment_method, close_date, side.
--
-- Ported from `commissions` so nothing is lost in the merge (owner rule: keep
-- the advanced surface, add what it lacks):
--   total_fees / net_to_agent / net_to_brokerage — fee + net math
--   cap_applied / calculation_version            — cap tracking + versioning
--   deposit_received_at / deposit_received_by    — post-close deposit lifecycle (m249)
--
-- Naming pairs that need translation at repoint time (no new columns):
--   commissions.paid_date        -> agent_commissions.paid_at
--   commissions.split_percentage -> agent_commissions.agent_split_percent
--
-- Additive and idempotent: existing readers/writers of either table keep
-- working until every consumer is repointed, then `commissions` is dropped.
ALTER TABLE agent_commissions
  ADD COLUMN IF NOT EXISTS total_fees numeric,
  ADD COLUMN IF NOT EXISTS net_to_agent numeric,
  ADD COLUMN IF NOT EXISTS net_to_brokerage numeric,
  ADD COLUMN IF NOT EXISTS cap_applied boolean,
  ADD COLUMN IF NOT EXISTS calculation_version text,
  ADD COLUMN IF NOT EXISTS deposit_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS deposit_received_by text;
