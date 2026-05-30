-- 997-create-qr-tracking-tables.sql
-- Creates qr_codes and qr_scan_events tables for QR tracking across direct mail,
-- newsletters, blog posts, and marketing assets.

CREATE TABLE IF NOT EXISTS qr_codes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    uuid REFERENCES brokerages(id),
  agent_user_id   uuid REFERENCES users(id),
  slug            text UNIQUE NOT NULL DEFAULT substr(md5(random()::text), 1, 10),
  label           text,
  target_url      text NOT NULL,
  purpose         text NOT NULL, -- listing | open_house | general | campaign | lead_capture | newsletter | blog
  magnet_id       uuid,
  campaign_id     uuid,
  is_active       boolean DEFAULT true,
  scan_count      int DEFAULT 0,
  lead_count      int DEFAULT 0,
  created_at      timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS qr_scan_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qr_code_id    uuid REFERENCES qr_codes(id) ON DELETE CASCADE,
  campaign_id   uuid,
  ip_address    text,
  user_agent    text,
  referrer      text,
  is_first_scan boolean DEFAULT false,
  scanned_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qr_codes_slug        ON qr_codes(slug);
CREATE INDEX IF NOT EXISTS idx_qr_codes_brokerage   ON qr_codes(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_qr_scan_events_qr    ON qr_scan_events(qr_code_id);
CREATE INDEX IF NOT EXISTS idx_qr_scan_events_camp  ON qr_scan_events(campaign_id);

ALTER TABLE qr_codes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE qr_scan_events ENABLE ROW LEVEL SECURITY;
