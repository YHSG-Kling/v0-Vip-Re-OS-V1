-- Migration: add email_signature column to users table
-- Required by: lib/kernel/communications/assemble-email.ts (per-user signature lookup)
-- The brokerage-level signature remains in brokerage_brand_settings.email_signature_html
-- This per-user field overrides the brokerage default when populated.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_signature TEXT;

COMMENT ON COLUMN users.email_signature IS
  'Per-agent plain-HTML email signature. Overrides brokerage_brand_settings.email_signature_html when set. Assembled by lib/kernel/communications/assemble-email.ts.';
