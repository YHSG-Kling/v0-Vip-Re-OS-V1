-- Pass 10 SoI: reconcile contacts.status vs contacts.contact_type for lifetime customers
-- contacts.status = 'lifetime_customer' is canonical going forward

-- Backfill: ensure all contact_type='lifetime' contacts also have the canonical status
UPDATE contacts
  SET status = 'lifetime_customer'
WHERE contact_type = 'lifetime'
  AND (status IS NULL OR status != 'lifetime_customer');

-- Prevent future divergence: if contact_type='lifetime', status must be 'lifetime_customer'
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_lifetime_consistent;
ALTER TABLE contacts ADD CONSTRAINT contacts_lifetime_consistent
  CHECK (contact_type != 'lifetime' OR status = 'lifetime_customer');
