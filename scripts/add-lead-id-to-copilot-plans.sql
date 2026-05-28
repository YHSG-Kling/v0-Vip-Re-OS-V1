-- Migration: Add lead_id to copilot_plans
-- The AI ISA can qualify both leads (pre-conversion) and contacts (post-conversion).
-- copilot_plans must support both: lead_id for pre-conversion records,
-- contact_id for post-conversion records, with a backlink between the two.

ALTER TABLE public.copilot_plans
  ADD COLUMN IF NOT EXISTS lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL;

-- Index for fast lookups by lead_id
CREATE INDEX IF NOT EXISTS copilot_plans_lead_id_idx ON public.copilot_plans(lead_id);

-- Also add a generated-columns-safe note: phone_digits in contacts is a regular
-- text column controlled by a DB trigger. Inserts must NOT include it directly.
-- (No DDL change needed here — this is a documentation constraint reminder.)
