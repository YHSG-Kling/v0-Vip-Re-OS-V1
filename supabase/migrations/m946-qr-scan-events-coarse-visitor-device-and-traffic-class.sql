-- ── APPLIED LIVE 2026-11-12 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 152, lane 152C ──
--
-- qr_scan_events — record only the PERMITTED context of a scan, and keep raw scans apart from visits.
-- Directive 152C (tracking contract): "records at most permitted contextual facts (time, QR ID, placement/campaign,
-- coarse device/source fields when allowed) without collecting unnecessary person-level data. Deduplicate obvious
-- bot/repeated hits to distinguish raw scans · filtered/human-likely visits · unique visitors only where technically and
-- legally supported." Before this, the scan door stored the raw IP address and the full browser string on every row,
-- and nothing told a link previewer from a phone.
--
-- CENSUS (live, read-only, 2026-11-11): qr_scan_events has id, qr_code_id, brokerage_id, contact_id, ip_address,
-- user_agent, referrer, is_first_scan, scanned_at, campaign_id — and 0 rows. Missing, each with its writer and reader:
--   visitor_key   — sha256(code | UTC day | coarse network /24·/48 | browser string), 32 hex: the same phone on the same
--                   day on THIS code, and nothing more (it cannot follow a person across codes or days). Writer:
--                   app/api/qr/scan (qrScanEvidence, lib/marketing/tracked-qr.ts). Readers: the repeat window
--                   (classifyScanForCode), the board's unique visitor-days (summarizeQrScans), the capture door (a
--                   consented submission may claim ONLY its own scan — app/api/qr/submit), the studio's per-code detail.
--   traffic_class — human_likely | bot | repeat (QR_TRAFFIC_CLASSES, lib/marketing/qr-contract.ts — the one code source).
--   device_class  — mobile | tablet | desktop | unknown (QR_DEVICE_CLASSES — the one code source).
-- The scan door stops writing ip_address and user_agent (the columns stay for rows recorded before; dropping them is
-- DROP COLUMN — owner SQL, and needless while 0 rows exist; lib/kernel/lead-magnets.ts still writes them until its
-- outside-lane request lands — lane 152C notes). `referrer` now carries the referring HOST only.
--
-- ROLLBACK: ALTER TABLE public.qr_scan_events DROP CONSTRAINT qr_scan_events_traffic_class_check, DROP CONSTRAINT
-- qr_scan_events_device_class_check. The three columns and the index are DROP COLUMN / DROP INDEX — owner SQL. The scan
-- door degrades without them (isAbsentColumnRefusal): it writes the earlier row shape minus the raw IP / browser string.

BEGIN;

ALTER TABLE public.qr_scan_events
  ADD COLUMN IF NOT EXISTS visitor_key   text,
  ADD COLUMN IF NOT EXISTS traffic_class text,
  ADD COLUMN IF NOT EXISTS device_class  text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'qr_scan_events_traffic_class_check') THEN
    ALTER TABLE public.qr_scan_events ADD CONSTRAINT qr_scan_events_traffic_class_check
      CHECK (traffic_class IS NULL OR traffic_class IN ('human_likely', 'bot', 'repeat'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'qr_scan_events_device_class_check') THEN
    ALTER TABLE public.qr_scan_events ADD CONSTRAINT qr_scan_events_device_class_check
      CHECK (device_class IS NULL OR device_class IN ('mobile', 'tablet', 'desktop', 'unknown'));
  END IF;
END $$;

-- The repeat window and the capture door read (qr_code_id, visitor_key, scanned_at DESC).
CREATE INDEX IF NOT EXISTS idx_qr_scan_events_code_visitor_time
  ON public.qr_scan_events (qr_code_id, visitor_key, scanned_at DESC)
  WHERE visitor_key IS NOT NULL;

COMMENT ON COLUMN public.qr_scan_events.visitor_key IS 'wave 152 (152C): sha256(code|UTC day|coarse network|browser) — one visitor of one code on one day; never the IP';
COMMENT ON COLUMN public.qr_scan_events.traffic_class IS 'wave 152 (152C): human_likely | bot | repeat — QR_TRAFFIC_CLASSES is the one code source';
COMMENT ON COLUMN public.qr_scan_events.device_class IS 'wave 152 (152C): mobile | tablet | desktop | unknown — QR_DEVICE_CLASSES is the one code source';

COMMIT;

-- READ-BACK (after apply):
--   SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'qr_scan_events'
--      AND column_name IN ('visitor_key','traffic_class','device_class');                                        -- 3 rows
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.qr_scan_events'::regclass
--      AND conname IN ('qr_scan_events_traffic_class_check','qr_scan_events_device_class_check');               -- 2 rows
--   SELECT indexname FROM pg_indexes WHERE tablename = 'qr_scan_events' AND indexname = 'idx_qr_scan_events_code_visitor_time';
-- Then regenerate scripts/schema-snapshot.ts and check-vocabularies.ts (two CHECKs), and lower NOT_APPLIED_BASELINE.
