-- ── APPLIED LIVE 2026-09-24 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
-- m664 — qr_codes: a PLATFORM-OWNED code carries no brokerage (wave 81, lane 81D)
--
-- Owner verbatim: "the qrcode system agent needs to make sure that any qrcode
-- that gets created for assets are added to the qrcode management which is
-- wired to the platform if used for platform or tenants dashboard."
--
-- qr_codes IS the QR management registry (lib/marketing/tracked-qr.ts is its
-- ONE writer). Ownership is the row's brokerage_id: a tenant's code carries its
-- brokerage (tenant board: app/dashboard/agent/qr-codes); a PLATFORM code — the
-- platform's own marketing (prospect funnel, staff business cards) — carries
-- NONE and shows on the platform board (app/dashboard/superadmin/qr-codes).
--
-- LIVE (hrvaqgvukzxfskkcrwbt, 2026-09-24): qr_codes.brokerage_id is NOT NULL,
-- so a platform-owned mint is refused today (mintTrackedQr returns null —
-- honest, never a row filed under some tenant). This migration lets the
-- platform own a code while keeping every tenant code anchored: a null
-- brokerage is legal ONLY for a label under the platform namespace
-- (PLATFORM_QR_LABEL_PREFIX = 'platform:'), and a tenant label can never lose
-- its brokerage.
--
-- No new vocabulary. Scan tracking rides the SAME survivor (qr_scan_events —
-- app/api/qr/scan stamps the event's brokerage_id from the code row); that
-- column is NOT NULL live too (verified 2026-09-24), so it is relaxed in step
-- so a platform code's scans are counted rather than refused.

ALTER TABLE public.qr_codes ALTER COLUMN brokerage_id DROP NOT NULL;
ALTER TABLE public.qr_scan_events ALTER COLUMN brokerage_id DROP NOT NULL;

ALTER TABLE public.qr_codes
  ADD CONSTRAINT qr_codes_platform_owner_check
  CHECK (brokerage_id IS NOT NULL OR label LIKE 'platform:%');

-- The platform board's own lookup (brokerage_id IS NULL, label, is_active) —
-- the same shape mintTrackedQr's idempotency read uses for a platform key.
CREATE INDEX IF NOT EXISTS idx_qr_codes_platform_owner
  ON public.qr_codes (label) WHERE brokerage_id IS NULL AND is_active = true;
