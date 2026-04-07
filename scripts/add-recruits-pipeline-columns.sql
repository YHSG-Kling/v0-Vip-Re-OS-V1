-- Add missing columns to recruits table for the pipeline feature
-- All idempotent via IF NOT EXISTS

ALTER TABLE recruits
  ADD COLUMN IF NOT EXISTS last_contact_date timestamp with time zone,
  ADD COLUMN IF NOT EXISTS contact_method text,
  ADD COLUMN IF NOT EXISTS referral_source text,
  ADD COLUMN IF NOT EXISTS provisioned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS provisioned_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS provisioned_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
