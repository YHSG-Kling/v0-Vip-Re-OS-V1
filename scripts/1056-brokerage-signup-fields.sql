-- ============================================================================
-- Migration 1056 — Brokerage signup top-of-funnel fields
-- ============================================================================
--
-- WHY:
--   A self-serve signup flow needs (a) a trial window so first-30-days
--   are free even without a card, (b) attribution so superadmin can see
--   where brokerages came from, and (c) a state field so the
--   onboarding UI knows whether a brokerage has completed setup.
--
-- WHAT:
--   trial_ends_at      — null = paid / not trial, else trial expiry timestamp
--   signup_source      — 'self_serve' | 'superadmin' | 'partner' | 'import'
--   onboarding_status  — 'pending' | 'in_progress' | 'completed' | 'abandoned'
--   No data backfill needed — pre-prod.
-- ============================================================================

BEGIN;

ALTER TABLE public.brokerages
  ADD COLUMN IF NOT EXISTS trial_ends_at     timestamptz,
  ADD COLUMN IF NOT EXISTS signup_source     text NOT NULL DEFAULT 'superadmin',
  ADD COLUMN IF NOT EXISTS onboarding_status text NOT NULL DEFAULT 'pending';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brokerages_signup_source_check') THEN
    ALTER TABLE public.brokerages
      ADD CONSTRAINT brokerages_signup_source_check
      CHECK (signup_source IN ('self_serve','superadmin','partner','import'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brokerages_onboarding_status_check') THEN
    ALTER TABLE public.brokerages
      ADD CONSTRAINT brokerages_onboarding_status_check
      CHECK (onboarding_status IN ('pending','in_progress','completed','abandoned'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_brokerages_signup_source
  ON public.brokerages(signup_source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_brokerages_trial_ends_at
  ON public.brokerages(trial_ends_at) WHERE trial_ends_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_brokerages_onboarding_status
  ON public.brokerages(onboarding_status);

COMMIT;
