-- Add ai_outreach_paused to leads for AI-ISA pause/resume control
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS ai_outreach_paused boolean NOT NULL DEFAULT false;

-- Also add stage column to ai_isa_qualifications since spec references it
ALTER TABLE public.ai_isa_qualifications
  ADD COLUMN IF NOT EXISTS stage text,
  ADD COLUMN IF NOT EXISTS last_outreach_at timestamp with time zone;

-- Back-fill stage from qualification_result for existing rows
UPDATE public.ai_isa_qualifications
SET stage = CASE
  WHEN qualification_result = 'qualified'      THEN 'qualified'
  WHEN qualification_result = 'needs_follow_up' THEN 'nurturing'
  WHEN qualification_result = 'in_progress'    THEN 'contacting'
  WHEN qualification_result = 'pending'        THEN 'awaiting_review'
  ELSE 'contacting'
END
WHERE stage IS NULL;
