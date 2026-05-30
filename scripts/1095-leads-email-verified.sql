-- Add email_verified to leads + raw_scraped_leads (already exists on contacts). Required by the
-- canonical AI-ISA channel rule: an unconsented lead may only be reached by email when the email is
-- verified (else only direct_mail is allowed). Default false so existing rows fail safely closed.
ALTER TABLE leads             ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;
ALTER TABLE raw_scraped_leads ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;
