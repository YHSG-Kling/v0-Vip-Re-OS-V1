-- l40-s01-lead-capture-forms-settings.sql
-- Per-form settings bag on lead_capture_forms (lead magnets / capture forms).
-- The original settings-column migration was never applied to the live DB, so
-- there was no clean home for per-form config (e.g. notify_on_submission) and
-- callers stashed flags in landing_content — which the AI-landing-copy save
-- overwrites. This adds the intended column, reconciling code ↔ live schema.
-- Additive, idempotent, non-breaking.

ALTER TABLE public.lead_capture_forms
  ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;
