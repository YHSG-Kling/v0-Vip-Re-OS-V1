-- Direct mail QR + piece type tracking
-- Wires direct_mail_campaigns to qr_codes so /api/qr/scan can attribute scans
-- back to a campaign, and adds piece_type so the create flow + preview know
-- whether the campaign is a postcard, letter, handwritten letter, or thank you note.

ALTER TABLE direct_mail_campaigns
  ADD COLUMN IF NOT EXISTS qr_code_id uuid REFERENCES qr_codes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tracking_id text,
  ADD COLUMN IF NOT EXISTS piece_type text DEFAULT 'postcard'; -- postcard | letter | handwritten_letter | thank_you_note

CREATE INDEX IF NOT EXISTS idx_direct_mail_campaigns_qr_code_id
  ON direct_mail_campaigns(qr_code_id);
CREATE INDEX IF NOT EXISTS idx_direct_mail_campaigns_tracking_id
  ON direct_mail_campaigns(tracking_id);

-- Direct campaign attribution on each scan event so the analytics tab can
-- group scans by campaign without an extra join.
ALTER TABLE qr_scan_events
  ADD COLUMN IF NOT EXISTS campaign_id uuid;

CREATE INDEX IF NOT EXISTS idx_qr_scan_events_campaign_id
  ON qr_scan_events(campaign_id);
