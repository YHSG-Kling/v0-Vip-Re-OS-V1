-- m205 — contact-level credit summary mirror. credit_accounts stays the CANONICAL
-- credit state (current_stage / account_status / scores / stage_history); these
-- denormalized mirrors let CRM segments, reporting, and automated runs key on the
-- contact directly. credit-copilot has written them since day one — but the columns
-- never existed, so every write PGRST204-failed: the credit pipeline kanban
-- (app/credit-pipeline) could never persist a stage move and status-change events
-- never fired.
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS credit_status         text,
  ADD COLUMN IF NOT EXISTS credit_score_band     text,
  ADD COLUMN IF NOT EXISTS credit_pipeline_stage text;
