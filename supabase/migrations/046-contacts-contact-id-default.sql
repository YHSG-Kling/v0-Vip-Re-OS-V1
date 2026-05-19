-- =====================================================
-- MIGRATION 046: contacts.contact_id default + contact-conversion drift
-- =====================================================
-- `contacts.contact_id` is UNIQUE NOT NULL with no default. Every existing
-- INSERT path either explicitly passes a UUID or fails the NOT NULL
-- check — a foot-gun the lead-to-contact conversion in
-- lib/application/lead-application-service.ts tripped over.
--
-- Adding gen_random_uuid() as the default makes new INSERTs work
-- transparently while preserving uniqueness for existing rows.
-- =====================================================

ALTER TABLE public.contacts
  ALTER COLUMN contact_id SET DEFAULT gen_random_uuid();
