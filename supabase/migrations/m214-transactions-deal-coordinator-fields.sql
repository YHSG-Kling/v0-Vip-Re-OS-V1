-- m214: Deal Coordinator transaction fields — the columns the deal-management,
-- contingency-watch, AI deal-health, and lost-deal-learning code already expects
-- but that never existed on transactions. Additive only; provider-agnostic
-- (no dotloop_* columns — those map to the existing external_provider_* set).
--
-- Grouped by the workflow that owns each field:

-- 1) Contingency tracking (proactive-checks.ts contingencyRemovalScan) — the
--    Deal Coordinator watches these deadlines and stamps removal on satisfaction.
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS inspection_deadline date,
  ADD COLUMN IF NOT EXISTS appraisal_deadline  date,
  ADD COLUMN IF NOT EXISTS financing_deadline  date,
  ADD COLUMN IF NOT EXISTS inspection_contingency_removed_at timestamptz,
  ADD COLUMN IF NOT EXISTS appraisal_contingency_removed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS financing_contingency_removed_at  timestamptz;

-- 2) Projected close (distinct from the actual close_date) — pipeline forecasting.
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS estimated_close_date date;

-- 3) AI deal-health (ai-transaction-coordinator.ts) — health_score already exists;
--    these carry the AI's narrative + label + win probability.
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS health_status     text,   -- healthy | watch | at_risk | critical
  ADD COLUMN IF NOT EXISTS ai_risk_level     text,
  ADD COLUMN IF NOT EXISTS ai_primary_risk   text,
  ADD COLUMN IF NOT EXISTS ai_analysis       jsonb,
  ADD COLUMN IF NOT EXISTS last_ai_analysis  timestamptz,
  ADD COLUMN IF NOT EXISTS win_probability   numeric;

-- 4) Lost-deal outcome learning (deal closes the loop on strategy outcomes).
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS lost_at               timestamptz,
  ADD COLUMN IF NOT EXISTS lost_category         text,
  ADD COLUMN IF NOT EXISTS lost_reason           text,
  ADD COLUMN IF NOT EXISTS earnest_money_outcome text;

-- 5) Financials carried from the accepted offer for closing math.
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS earnest_money numeric,
  ADD COLUMN IF NOT EXISTS loan_amount   numeric;

-- Index the contingency-scan and at-risk filters (cron-driven, brokerage-scoped).
CREATE INDEX IF NOT EXISTS idx_transactions_health_status ON public.transactions (brokerage_id, health_status);
CREATE INDEX IF NOT EXISTS idx_transactions_est_close     ON public.transactions (brokerage_id, estimated_close_date);
