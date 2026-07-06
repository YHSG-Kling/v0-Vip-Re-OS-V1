-- l21-s01-referrals-referrer-contact.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- REFERRER LOVE LOOP audit fix: referrals.referred_by was FREE TEXT (a name), so
-- the OS could not know WHO (as a contact) referred — and therefore could not keep
-- the referrer updated or send the configured appreciation. Link the referrer as a
-- CONTACT. Legacy rows stay null (no fabricated backfill from a text name).

ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS referrer_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_contact ON public.referrals(referrer_contact_id);
