-- ============================================================================
-- Migration 1047 — Customer onboarding journey-type awareness
-- ============================================================================
--
-- The five-step welcome arc I shipped in 1046 is buyer-tilted. A SELLER on
-- first arrival sees a different shape (upload property → review pricing
-- strategy → market-prep checklist), and a FOREVER (post-close) contact is
-- in a wealth-management arc (review home value → set refi alerts →
-- connect anniversaries → vendor marketplace tour). LIFETIME contacts who
-- come back to buy or sell again branch back into buyer/seller.
--
-- This migration:
--   1. Adds journey_type to customer_onboarding
--   2. Backfills existing rows from portal_view + contact_persona
--   3. Indexes (brokerage_id, journey_type, status) for cohort queries
-- ============================================================================

BEGIN;

ALTER TABLE customer_onboarding
  ADD COLUMN IF NOT EXISTS journey_type text NOT NULL DEFAULT 'buyer'
       CHECK (journey_type IN ('buyer','seller','forever','lifetime'));

-- Backfill from portal_view + contact_persona where helpful
UPDATE customer_onboarding
   SET journey_type = CASE
     WHEN portal_view = 'forever'                                              THEN 'forever'
     WHEN portal_view = 'lifetime'                                             THEN 'lifetime'
     WHEN contact_persona IN ('expired','fsbo','divorce','estate',
                              'downsize_seller','luxury_seller')               THEN 'seller'
     ELSE 'buyer'
   END
 WHERE journey_type = 'buyer';   -- only touch the default

CREATE INDEX IF NOT EXISTS idx_co_brokerage_journey_status
  ON customer_onboarding (brokerage_id, journey_type, status);

COMMIT;
