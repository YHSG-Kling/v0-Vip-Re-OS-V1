-- Phase 1B: Rename past_client_touchpoints → lifetime_customer_touchpoints
-- and update the contacts.contact_type constraint to accept 'lifetime_customer'.
-- Run this after Phase 1A code changes are deployed.
-- Idempotent: all steps use IF EXISTS / IF NOT EXISTS guards.

BEGIN;

-- 1. Rename the table (only if old name still exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables WHERE tablename = 'past_client_touchpoints'
  ) THEN
    ALTER TABLE past_client_touchpoints
      RENAME TO lifetime_customer_touchpoints;
  END IF;
END $$;

-- 2. Rename indexes (old names → new names, skip if already renamed)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_past_client_touchpoints_agent')
  THEN
    ALTER INDEX idx_past_client_touchpoints_agent
      RENAME TO idx_lifetime_customer_touchpoints_agent;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_past_client_touchpoints_contact')
  THEN
    ALTER INDEX idx_past_client_touchpoints_contact
      RENAME TO idx_lifetime_customer_touchpoints_contact;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_past_client_touchpoints_status')
  THEN
    ALTER INDEX idx_past_client_touchpoints_status
      RENAME TO idx_lifetime_customer_touchpoints_status;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_past_client_touchpoints_scheduled_date')
  THEN
    ALTER INDEX idx_past_client_touchpoints_scheduled_date
      RENAME TO idx_lifetime_customer_touchpoints_scheduled_date;
  END IF;
END $$;

-- 3. Update contacts.contact_type CHECK constraint to accept both values
--    during the transition window.
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_contact_type_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_contact_type_check
  CHECK (contact_type IN (
    'lead', 'prospect', 'client', 'lifetime', 'lifetime_customer',
    'past_client', 'sphere', 'vendor', 'referral_partner', 'investor', 'other'
  ));

-- 4. Backfill: update contact_type from 'past_client' to 'lifetime_customer'
UPDATE contacts
  SET contact_type = 'lifetime_customer'
WHERE contact_type = 'past_client';

-- 5. Update activity_type strings from past_client_touchpoint_sent
UPDATE activities
  SET activity_type = 'lifetime_customer_touchpoint_sent'
WHERE activity_type = 'past_client_touchpoint_sent';

-- 6. Drop 'past_client' from the constraint once backfill is verified.
--    (Uncomment and run this step after confirming zero rows use 'past_client'.)
-- ALTER TABLE contacts DROP CONSTRAINT contacts_contact_type_check;
-- ALTER TABLE contacts ADD CONSTRAINT contacts_contact_type_check
--   CHECK (contact_type IN (
--     'lead', 'prospect', 'client', 'lifetime', 'lifetime_customer',
--     'sphere', 'vendor', 'referral_partner', 'investor', 'other'
--   ));

COMMIT;
