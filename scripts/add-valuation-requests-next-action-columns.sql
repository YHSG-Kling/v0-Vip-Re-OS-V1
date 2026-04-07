-- Kernel OS: Next-action tracking columns for valuation_requests
-- Idempotent via IF NOT EXISTS

ALTER TABLE valuation_requests
  ADD COLUMN IF NOT EXISTS cma_sent            boolean   DEFAULT false,
  ADD COLUMN IF NOT EXISTS cma_sent_at         timestamptz,
  ADD COLUMN IF NOT EXISTS appointment_scheduled boolean  DEFAULT false,
  ADD COLUMN IF NOT EXISTS appointment_at      timestamptz;
