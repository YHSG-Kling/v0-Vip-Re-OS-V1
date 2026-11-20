-- ── APPLIED LIVE 2026-11-09 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 151, lane 151J ──
--
-- m983 — A SAVED HOME REMEMBERS ITS LAST VERIFIED STATE (wave 151, lane 151J; directive 151J "Saved-home alerts":
-- "source snapshot/update → source-specific listing identity and freshness → diff against the last verified state →
-- saved-property subscription → event → the existing arbiter → … → alert history").
--
-- THE SURVIVOR IS `saved_properties` (wave 150, lane 150W: the ONE saved-home table; `property_interests` holds search
-- criteria). Live 2026-11-09 (read-only, information_schema.columns): the table carries the home's facts and its ORIGIN
-- (`source`, `external_property_id`, `mls_number`, `mls_name`, `source_url` — m991) but NOTHING about when the source
-- was last read or what it said — so a price or status change on a saved RentCast / pasted-link / IDX home could not
-- be DIFFED (OWNER-SQL §L L6.10, lane-150Z convergence row 76). The criteria-based alert engine keeps its own send
-- ledger (property_alert_results, UNIQUE (alert_id, mls_number)); a SAVED home is a different subscription and gets
-- its baseline here, on its own row, never a second table.
--
-- Columns (all nullable — a row written before this migration is "never verified", which the watch reads honestly):
--   last_verified_at          when the source was last read for this home (a detection poll, never a notification cadence)
--   last_verified_status      the source's listing status on OUR vocabulary (lib/property/resolve-property-facts.ts
--                             normalizeVendorStatus: active | coming_soon | pending | sold | withdrawn | expired | off_market)
--                             — no CHECK: the function's outputs ARE the vocabulary (a constant beside it could drift, §6)
--   last_verified_price       the asking price the source reported at that read (numeric, like list_price)
--   last_verified_mls_number  the MLS number at that read — a RE-LISTING UNDER A NEW MLS ID is detected as the same
--                             property (same source identity) carrying a new number, and announced ONCE
--   last_verified_source      which source answered: ONE code constant, lib/property-alerts/saved-home-watch.ts
--                             SAVED_HOME_VERIFICATION_SOURCES (tenant_listing | idx_mls | rentcast_listing | buyer_url)
--   verification_hold         why the LAST sweep could not verify this home, in plain words (a metered RentCast re-read
--                             held for want of a tenant-approved plan line / the platform caps; an IDX home with no by-id
--                             read; a pasted link whose status is unverifiable by address) — NEVER a silent poll
--
-- NO second alert table (m984 is unused): the alert HISTORY rides the survivors — the contact's `notifications` row
-- (contact_id, type saved_home_alert, entity saved_property, read_at = the buyer's acknowledgement), the decision on
-- `agent_action_ledger` (saved_home.alert, idempotent per home + change + state digest) and the audit event on
-- `lifecycle_events` (saved_home.alert, audit-only).
--
-- Live rows at write time: saved_properties = 0 (read-only count 2026-11-09) → no backfill.

BEGIN;

ALTER TABLE public.saved_properties
  ADD COLUMN IF NOT EXISTS last_verified_at         timestamptz,
  ADD COLUMN IF NOT EXISTS last_verified_status     text,
  ADD COLUMN IF NOT EXISTS last_verified_price      numeric,
  ADD COLUMN IF NOT EXISTS last_verified_mls_number text,
  ADD COLUMN IF NOT EXISTS last_verified_source     text,
  ADD COLUMN IF NOT EXISTS verification_hold        text;

-- ONE vocabulary, ONE source constant (lib/property-alerts/saved-home-watch.ts SAVED_HOME_VERIFICATION_SOURCES).
-- A NULL passes a CHECK on its own (no `IS NULL OR` arm — the vocabulary guard reads that shape as pending).
ALTER TABLE public.saved_properties DROP CONSTRAINT IF EXISTS saved_properties_last_verified_source_check;
ALTER TABLE public.saved_properties
  ADD CONSTRAINT saved_properties_last_verified_source_check
  CHECK (last_verified_source IN ('tenant_listing', 'idx_mls', 'rentcast_listing', 'buyer_url'));

ALTER TABLE public.saved_properties DROP CONSTRAINT IF EXISTS saved_properties_verification_hold_len;
ALTER TABLE public.saved_properties
  ADD CONSTRAINT saved_properties_verification_hold_len CHECK (char_length(verification_hold) <= 400);

COMMENT ON COLUMN public.saved_properties.last_verified_at         IS 'wave 151 (151J): when the saved home''s source was last read by the saved-home watch (detection poll; the arbiter decides notification timing).';
COMMENT ON COLUMN public.saved_properties.last_verified_status     IS 'wave 151 (151J): the source''s listing status at the last read, on the normalizeVendorStatus vocabulary (active | coming_soon | pending | sold | withdrawn | expired | off_market).';
COMMENT ON COLUMN public.saved_properties.last_verified_price      IS 'wave 151 (151J): the asking price the source reported at the last read.';
COMMENT ON COLUMN public.saved_properties.last_verified_mls_number IS 'wave 151 (151J): the MLS number at the last read — a re-listing under a new MLS id is the same saved home carrying a new number (announced once).';
COMMENT ON COLUMN public.saved_properties.last_verified_source     IS 'wave 151 (151J): which source answered the last read — SAVED_HOME_VERIFICATION_SOURCES (lib/property-alerts/saved-home-watch.ts).';
COMMENT ON COLUMN public.saved_properties.verification_hold        IS 'wave 151 (151J): why the last sweep could not verify this home (metered re-read held for want of approval; no IDX by-id read; status unverifiable by address) — recorded, never a silent poll.';

-- The watch reads "not dismissed, in this tenant, oldest verification first".
CREATE INDEX IF NOT EXISTS idx_saved_properties_watch
  ON public.saved_properties (brokerage_id, dismissed, last_verified_at);

COMMIT;

-- After apply (integrator): regenerate scripts/schema-snapshot.ts (six columns) and scripts/check-vocabularies.ts
-- (saved_properties.last_verified_source), then add the mirror to scripts/check-vocabulary-guard.ts:
--   { file: "lib/property-alerts/saved-home-watch.ts", constant: "SAVED_HOME_VERIFICATION_SOURCES",
--     table: "saved_properties", column: "last_verified_source", constraint: "saved_properties_last_verified_source_check" }
--
-- Read-back (the integrator ran it 2026-11-09: 6 columns, both CHECKs, the watch index):
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'saved_properties' AND column_name LIKE 'last_verified_%' OR (table_name = 'saved_properties' AND column_name = 'verification_hold');
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.saved_properties'::regclass AND conname IN ('saved_properties_last_verified_source_check', 'saved_properties_verification_hold_len');
