-- Lead Magnet Schema Patch
-- Adds missing columns to support the lead magnet kernel OS commands.
-- Safe to run multiple times (all changes use IF NOT EXISTS or DO $$ blocks).

-- 1. lead_capture_forms: ensure tcpa_disclosure_text, thank_you_message, redirect_url exist
ALTER TABLE lead_capture_forms
  ADD COLUMN IF NOT EXISTS tcpa_disclosure_text TEXT,
  ADD COLUMN IF NOT EXISTS thank_you_message TEXT,
  ADD COLUMN IF NOT EXISTS redirect_url TEXT;

-- 2. lead_capture_forms: updated_at column for updateMagnetSettings
ALTER TABLE lead_capture_forms
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- 3. qr_codes: ensure purpose column exists and lead_magnet is a valid value
ALTER TABLE qr_codes
  ADD COLUMN IF NOT EXISTS purpose TEXT DEFAULT 'general';

-- 4. form_submissions: ensure source column for tracking
ALTER TABLE form_submissions
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'direct';

-- 5. Ensure lifecycle_events brokerage_id is indexed for performance queries
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_brokerage_entity
  ON lifecycle_events (brokerage_id, entity_id, event_type);

-- 6. Ensure form_submissions is indexed for performance queries
CREATE INDEX IF NOT EXISTS idx_form_submissions_form_brokerage
  ON form_submissions (form_id, brokerage_id, submitted_at DESC);

-- 7. qr_codes: lead_magnet purpose index
CREATE INDEX IF NOT EXISTS idx_qr_codes_brokerage_purpose
  ON qr_codes (brokerage_id, purpose, is_active);
