-- m233 — first-class lead enrichment columns (raw→leads→contacts field parity).
-- Leads held home ownership / life events only inside enrichment_profile jsonb, and had NO
-- dnc_status at all. Promoting these to first-class columns makes lead segmentation/scoring as
-- rich as contacts, lets persona copy read ownership directly, and — critically — gives leads a
-- dnc_status suppression flag (closing a real gap: a DNC lead had nowhere to record it).
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS home_owner_status text,
  ADD COLUMN IF NOT EXISTS life_events       jsonb,
  ADD COLUMN IF NOT EXISTS dnc_status        boolean DEFAULT false;
