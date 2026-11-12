-- ── WRITTEN, NOT APPLIED — the integrator applies it (CLAUDE.md §3: files are not the database) ──
--
-- m771 — AIRTABLE IS RETIRED (owner, wave 141, 2026-10-14; lane 141D): drop the one schema
--        remnant of the Airtable era, global_settings.airtable_api_key.
--
-- LIVE, READ 2026-10-14 (project hrvaqgvukzxfskkcrwbt, before writing this):
--   · global_settings: 0 rows; airtable_api_key text NULL — 0 non-null values. Nothing to keep.
--   · NO reader and NO writer in lib/ app/ services/ components/: the column was only ever
--     DECLARED on lib/kernel/global-settings.ts::GlobalSettingsRow (corrected in the same patch —
--     the type no longer names it, so no `.update({ airtable_api_key })` can target a dropped
--     column and have PostgREST refuse the whole row, PGRST204). The settings UI never exposed it;
--     the hardened secrets writer the kernel header promises was never built for it.
--   · lib/platform/config-snapshots.ts keeps the NAME in SNAPSHOT_FORBIDDEN_FIELDS on purpose:
--     a historical snapshot payload that still carries it is REFUSED by payloadLeaksSecret
--     rather than applied onto this dropped column.
--   · The Airtable → Supabase data migration finished long ago (lib/migration-status.ts is the
--     record); the four remaining Airtable operational scripts are deleted in the same patch.
--
-- SCOPE, DELIBERATELY NARROW. This drops ONE column. It does NOT touch the SMTP columns
-- (smtp_host / smtp_port / smtp_username / smtp_password / from_email / from_name — owner:
-- "SMTP is already configured"; lib/onboarding/setup-readiness.ts and critical-setup.ts read
-- smtp_host/from_email as the email-provider-configured signal) and it does NOT touch
-- ghl_api_key (owner: "GHL is already configured"). scripts/crm-boundaries-guard.ts pins both.
--
-- Historical data: none exists in this column (0 values live), so nothing is destroyed. If a
-- value ever appears before apply, the integrator reads it first — the owner's rule is "never
-- destroy historical data blindly", and a retired vendor's API key is a credential, not history.
--
-- Two-part apply (wave 98 rule): this file is PART 1 only (a column drop); there is no part 2
-- (no index, no trigger, no policy touches this column).
--
-- Rollback: ALTER TABLE public.global_settings ADD COLUMN airtable_api_key text;

ALTER TABLE public.global_settings DROP COLUMN IF EXISTS airtable_api_key;

COMMENT ON TABLE public.global_settings IS
  'Per-brokerage app settings. airtable_api_key dropped by m771 (Airtable retired, wave 141); zapier_api_key dropped by m678. SMTP + ghl_api_key columns stay (configured paths).';
