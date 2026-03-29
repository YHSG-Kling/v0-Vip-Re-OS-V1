-- Migration: add copy_text column to direct_mail_campaigns
-- Safe: uses IF NOT EXISTS semantics via DO block

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'direct_mail_campaigns'
      AND column_name = 'copy_text'
  ) THEN
    ALTER TABLE direct_mail_campaigns ADD COLUMN copy_text TEXT;
  END IF;
END;
$$;
