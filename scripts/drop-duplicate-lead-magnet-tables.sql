-- Drop duplicate lead magnet tables created by mistake
-- These conflict with existing lead_capture_forms, form_submissions, qr_codes schema

DROP TABLE IF EXISTS lead_magnet_downloads CASCADE;
DROP TABLE IF EXISTS lead_magnets CASCADE;

-- Note: The correct existing tables are:
-- - lead_capture_forms (for lead magnet forms)
-- - form_submissions (for tracking submissions)
-- - qr_codes (for QR code tracking)
-- - qr_scan_events (for scan tracking)
