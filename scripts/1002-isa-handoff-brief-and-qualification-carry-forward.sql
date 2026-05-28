-- ===========================================================================
-- 1002-isa-handoff-brief-and-qualification-carry-forward.sql
-- Adds qualification fields and ISA handoff brief jsonb to contacts so all
-- ISA-captured data carries forward at conversion. Mirrors the same fields
-- on leads so they can be captured DURING ISA conversations.
--
-- APPLIED VIA: supabase apply_migration "isa_handoff_brief_and_qualification_carry_forward"
-- ===========================================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS budget_min numeric,
  ADD COLUMN IF NOT EXISTS budget_max numeric,
  ADD COLUMN IF NOT EXISTS motivation_type text,
  ADD COLUMN IF NOT EXISTS motivation_confidence numeric,
  ADD COLUMN IF NOT EXISTS urgency_level text,
  ADD COLUMN IF NOT EXISTS lender_status text
    CHECK (lender_status IS NULL OR lender_status IN ('cash','pre_approved','needs_pre_approval','unknown')),
  ADD COLUMN IF NOT EXISTS equity_estimate numeric,
  ADD COLUMN IF NOT EXISTS qualification_summary text,
  ADD COLUMN IF NOT EXISTS isa_handoff_brief jsonb,
  ADD COLUMN IF NOT EXISTS isa_handoff_at timestamptz,
  ADD COLUMN IF NOT EXISTS isa_qualification_score numeric;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS lender_status text
    CHECK (lender_status IS NULL OR lender_status IN ('cash','pre_approved','needs_pre_approval','unknown')),
  ADD COLUMN IF NOT EXISTS equity_estimate numeric,
  ADD COLUMN IF NOT EXISTS qualification_summary text,
  ADD COLUMN IF NOT EXISTS isa_handoff_brief jsonb;

CREATE INDEX IF NOT EXISTS idx_contacts_urgency ON public.contacts(urgency_level)
  WHERE urgency_level IN ('high','urgent');
CREATE INDEX IF NOT EXISTS idx_contacts_handoff_at ON public.contacts(isa_handoff_at DESC)
  WHERE isa_handoff_at IS NOT NULL;
