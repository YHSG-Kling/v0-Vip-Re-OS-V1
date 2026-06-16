-- 1102: rate-lock columns on transaction_lenders — the RATE-LOCK EXPIRATION WATCH gap.
-- A buyer's mortgage rate is locked for a finite window (commonly 30/45/60 days). If the
-- closing date slips toward or past the lock's expiration, the buyer must pay to extend the
-- lock or re-lock at a (usually worse) rate — real money, and nothing in the stack watched
-- it (transaction_lenders carried interest_rate + clear_to_close_date but no lock dates).
-- These additive columns let the Deal Coordinator's Rate-Lock Watch count down the lock vs
-- the scheduled closing and warn BEFORE it lapses. Applied live via Supabase MCP migration
-- `add_rate_lock_to_transaction_lenders`.

ALTER TABLE transaction_lenders
  ADD COLUMN IF NOT EXISTS rate_lock_date            date,
  ADD COLUMN IF NOT EXISTS rate_lock_expiration_date date,
  ADD COLUMN IF NOT EXISTS rate_lock_extended_at     timestamptz;

CREATE INDEX IF NOT EXISTS idx_txn_lenders_rate_lock_exp
  ON transaction_lenders(rate_lock_expiration_date) WHERE rate_lock_expiration_date IS NOT NULL;
