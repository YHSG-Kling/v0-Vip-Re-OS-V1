-- Layer 15 Sprint 01: Add lead_id columns to voice_calls and ai_isa_calls
-- Required for AI-ISA outbound calls that originate from lead records
-- before a contact record has been created (unconsented leads).
-- Architecture rule:
--   contact_id set → call from a contacts row (post-conversion)
--   lead_id set    → call from a leads row (no contact yet)
-- Both are mutually exclusive per call row.

ALTER TABLE public.voice_calls
  ADD COLUMN IF NOT EXISTS lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL;

ALTER TABLE public.ai_isa_calls
  ADD COLUMN IF NOT EXISTS lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL;

-- Indexes for lookup by lead
CREATE INDEX IF NOT EXISTS idx_voice_calls_lead_id
  ON public.voice_calls(lead_id)
  WHERE lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_isa_calls_lead_id
  ON public.ai_isa_calls(lead_id)
  WHERE lead_id IS NOT NULL;
