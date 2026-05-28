-- m092: add approval-tracking fields to agent_commissions
-- markCommissionApproved() records approved_at + approved_by during the
-- pending → approved transition, but those columns were never added to the
-- live table. Additive, non-destructive. (paid_at/payment_method added in m090.)

ALTER TABLE public.agent_commissions
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by text;
