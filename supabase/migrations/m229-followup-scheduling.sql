-- m229 — explicit future-intent re-contact date.
-- When a lead/contact says "reach out in 6 months", capture the date so the reactivation cadence
-- HONORS it (suppress nagging until the date, then re-engage) instead of relying purely on age
-- heuristics. No existing column held a forward-looking re-contact date (audit confirmed).
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS next_followup_at     timestamptz,
  ADD COLUMN IF NOT EXISTS next_followup_reason text;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS next_followup_at     timestamptz,
  ADD COLUMN IF NOT EXISTS next_followup_reason text;

-- Partial indexes so the "due for re-contact" sweep stays cheap.
CREATE INDEX IF NOT EXISTS idx_contacts_next_followup_at ON public.contacts(next_followup_at) WHERE next_followup_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_next_followup_at    ON public.leads(next_followup_at)    WHERE next_followup_at IS NOT NULL;
