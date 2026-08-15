-- ============================================================================
-- Migration 1078 — offers: contract-dictated EMD deadline
-- ============================================================================

ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS earnest_money_due_days int,
  ADD COLUMN IF NOT EXISTS earnest_money_due_at   timestamp with time zone;

CREATE INDEX IF NOT EXISTS offers_em_due_at_idx
  ON public.offers (brokerage_id, earnest_money_due_at)
  WHERE earnest_money_due_at IS NOT NULL;
