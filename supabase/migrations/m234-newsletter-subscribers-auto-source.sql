-- m234 — allow the lifecycle auto-enrollment source values on newsletter_subscribers.
--
-- The content auto-enrollment (enrollLeadInNewsletter / enrollContactInNewsletter) writes
--   source = 'auto_lead_capture' | 'auto_contact' | 'auto_lifetime'
-- but the original source CHECK constraint only allowed
--   'manual','import','form','open_house','qr_scan','portal'.
-- Every auto-enroll INSERT therefore violated the constraint and failed, so LEADS, CONTACTS, and
-- LIFETIME customers were never enrolled into the newsletter at all (a silent drop of every
-- lifecycle-acquired subscriber). This extends the constraint to match the documented code intent.

ALTER TABLE newsletter_subscribers DROP CONSTRAINT IF EXISTS newsletter_subscribers_source_check;
ALTER TABLE newsletter_subscribers ADD CONSTRAINT newsletter_subscribers_source_check
  CHECK (source = ANY (ARRAY[
    'manual','import','form','open_house','qr_scan','portal',
    'auto_lead_capture','auto_contact','auto_lifetime'
  ]));
