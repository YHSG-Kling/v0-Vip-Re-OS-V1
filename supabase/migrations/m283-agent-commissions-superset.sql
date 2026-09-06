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

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2 STATUS: all 7 code consumers are repointed to agent_commissions (this
-- change), so NOTHING in the app reads or writes `commissions` anymore. The
-- table itself is deliberately NOT dropped yet — a live dependency sweep found
-- three objects still bound to it, and CASCADE would silently destroy them:
--
--   1. commission_distributions.commission_id  FK -> commissions(id)
--   2. earnings_history.commission_id          FK -> commissions(id)
--   3. financial_dashboard_view                view selects from commissions
--
-- Dropping safely requires, in order: repoint both FKs at agent_commissions(id)
-- (both tables are currently empty, so this is a constraint swap, not a data
-- migration), rewrite financial_dashboard_view against agent_commissions, THEN
-- backfill + drop. The backfill is written and verified against the live column
-- contract (agent_commission / brokerage_commission are GENERATED on the keeper
-- and must be omitted; paid_date -> paid_at, split_percentage ->
-- agent_split_percent) and is ready to run once the three dependents move.
--
-- Leaving the orphaned table in place is SAFE (no code path touches it) and is
-- strictly better than a CASCADE that takes a view and two FKs with it.
