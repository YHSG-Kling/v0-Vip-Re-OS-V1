-- m090: add paid-tracking fields to agent_commissions
-- The financial kernel (lib/kernel/financial.ts) treats agent_commissions as the
-- canonical commission table with status transitions calculated → approved → paid.
-- markCommissionPaid() records paid_at + payment_method, and the agent financial
-- dashboard reads paid_at — but those columns were never added to the live table.
-- Additive, non-destructive.

ALTER TABLE public.agent_commissions
  ADD COLUMN IF NOT EXISTS paid_at        timestamptz,
  ADD COLUMN IF NOT EXISTS payment_method text;
