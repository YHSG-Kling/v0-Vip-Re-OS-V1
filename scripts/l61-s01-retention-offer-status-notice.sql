-- l61-s01-retention-offer-status-notice.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- SAAS LOOP-CLOSERS on the platform_settings SINGLETON (no new tables):
--
--   retention_offer jsonb — which platform_coupons code is presented as the
--     cancellation save-offer, plus the headline shown to a tenant admin who
--     clicks "Cancel subscription". Configured on the superadmin coupons page;
--     read by the tenant cancel flow (app/actions/billing.ts). Empty {} = no
--     save-offer configured → the cancel flow proceeds straight to confirm
--     (honest: no offer is invented).
--
--   status_notice jsonb — the platform → TENANT incident/status broadcast the
--     comms rail was missing (platform_announcements reach STAFF only). Set by
--     superadmin on /dashboard/superadmin/platform; rendered on the tenant
--     "What's new & platform status" page. Empty {} / active:false = no notice.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); all readers fail soft when the
-- columns are absent, so applying this is an enhancement, never a prerequisite.

ALTER TABLE public.platform_settings ADD COLUMN IF NOT EXISTS retention_offer jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.platform_settings ADD COLUMN IF NOT EXISTS status_notice   jsonb NOT NULL DEFAULT '{}'::jsonb;
