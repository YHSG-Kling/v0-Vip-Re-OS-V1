-- m196 — contacts.lead_score: the contact-stage lead-quality score the lead-management service
-- computes and writes to contacts (errored without the column, so scores never persisted).
-- Distinct from intent_score/engagement_score/isa_qualification_score; the service explicitly
-- targets contacts (a promoted lead being re-scored), so it lives here.
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS lead_score numeric;
