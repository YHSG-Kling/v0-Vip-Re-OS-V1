-- Add missing columns to activities that the interaction functionality needs.
-- activities is the canonical table; interactions was incorrectly created.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS channel text;

-- Drop the incorrectly created interactions table
DROP TABLE IF EXISTS interactions;
