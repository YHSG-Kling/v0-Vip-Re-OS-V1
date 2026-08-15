-- ============================================================================
-- Migration 1048 — Align customer_onboarding.journey_type with portal kernel
-- ============================================================================
--
-- The portal kernel (lib/kernel/portal.ts:PortalView) only emits three
-- values: 'buyer' | 'seller' | 'lifetime'. The 'lifetime' view IS the
-- post-close / forever-mode arc (decision logic: closed transaction +
-- no active transaction OR buyer_stage='BUYER_LIFETIME').
--
-- Migration 1047 introduced a 'forever' journey_type alongside 'lifetime',
-- which created a dead value — nothing ever set it because no
-- portal_view='forever' exists. This migration:
--   1. Merges any 'forever' rows back into 'lifetime'
--   2. Tightens the CHECK to ('buyer','seller','lifetime')
--
-- Result: customer_onboarding mirrors the kernel exactly. No parallel.
-- ============================================================================

BEGIN;

-- Merge any 'forever' rows back into 'lifetime' (kernel's post-close arc)
UPDATE customer_onboarding SET journey_type = 'lifetime' WHERE journey_type = 'forever';

-- Replace the CHECK constraint
ALTER TABLE customer_onboarding
  DROP CONSTRAINT IF EXISTS customer_onboarding_journey_type_check;
ALTER TABLE customer_onboarding
  ADD CONSTRAINT customer_onboarding_journey_type_check
  CHECK (journey_type IN ('buyer','seller','lifetime'));

COMMIT;
