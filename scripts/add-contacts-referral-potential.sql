-- Add referral_potential column to contacts table
-- Values: 'high', 'medium', 'low', NULL (unknown)
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS referral_potential text
    CHECK (referral_potential IN ('high', 'medium', 'low'));
