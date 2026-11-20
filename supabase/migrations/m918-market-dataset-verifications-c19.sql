-- ── APPLIED LIVE 2026-11-01 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 148, lane 148F ──
--
-- m918 — market_dataset_verifications: THE C19 DATASET VERIFICATION LOG (wave 148, lane 148F — owner ruling 6, 2026-11-01:
-- "create a dataset verification in the market registry"; "probate / deed-transfer / relocation / permit datasets verified before use").
--
-- One row per VERIFICATION OBSERVATION of one market-registry dataset (`host/datasetId`, the permit sweep's own dedupe key):
--   source · licence · geography · coverage · freshness · last_verified_at · confidence · data_rights · drift · verified_by
-- The CODE contract (lib/external/socrata-market-registry.ts MARKETS + MARKET_DATASET_CANDIDATES — the live-row read and the
-- licence, each dated) is derived by lib/intent/dataset-verification.ts; this table is where the FEED speaks back: the daily
-- permit sweep (app/api/cron/permit-signal-scan → recordDatasetObservations) records a served window with rows (freshness) or a
-- refusal after a verified state (DRIFT). The latest row per dataset (by observed_at) is overlaid on the code contract; an
-- observation can prove a feed MOVING or DRIFTED, never supply a licence the registry never read.
--
-- THE RULE IT FEEDS: a dataset whose status is not `verified` lends the `unknown` ceiling — lib/intent/movement-signals.ts
-- recordMovementSignal stores a public-record record citing it as `unknown` (or refuses an intimate one), so an unverified source
-- can never raise a signal above unknown.
--
-- PLATFORM-SCOPED, NOT TENANT-SCOPED: a dataset is public open data, the same fact for every tenant — the row carries NO
-- brokerage_id (which tenant's sweep observed it would leak a tenant's territory to every other tenant). Reads: any authenticated
-- user (public-data metadata); writes: the service role only (the sweep, through the writer above).
--
-- One observation per dataset per day per outcome (idempotency_key UNIQUE) — the sweep runs per tenant and must not write ten
-- copies of one fact.

CREATE TABLE IF NOT EXISTS public.market_dataset_verifications (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_key       text        NOT NULL,
  host              text        NOT NULL,
  dataset_id        text        NOT NULL,
  provider          text        NOT NULL
    CONSTRAINT market_dataset_verifications_provider_check CHECK (provider IN ('socrata', 'arcgis', 'file', 'licensed_api')),
  kind              text        NOT NULL
    CONSTRAINT market_dataset_verifications_kind_check CHECK (kind IN ('permits', 'code_violations', 'probate', 'property_transfers', 'street_use_permits', 'change_of_address')),
  label             text,
  source            text        NOT NULL,
  licence           jsonb,
  geography         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  coverage          text,
  data_rights       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  freshness         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  last_verified_at  timestamptz,
  observed_at       timestamptz NOT NULL DEFAULT now(),
  confidence        text        NOT NULL
    CONSTRAINT market_dataset_verifications_confidence_check CHECK (confidence IN ('verified', 'unknown')),
  status            text        NOT NULL
    CONSTRAINT market_dataset_verifications_status_check CHECK (status IN ('verified', 'stale', 'drifted', 'unverified', 'unavailable')),
  drift             text,
  method            text        NOT NULL
    CONSTRAINT market_dataset_verifications_method_check CHECK (method IN ('registry_seed', 'live_row_read', 'sweep_observation', 'catalog_probe', 'manual')),
  verified_by       text        NOT NULL,
  evidence          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key   text        NOT NULL
    CONSTRAINT market_dataset_verifications_idempotency_key_key UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- the ceiling follows the status: only a verified dataset lends `verified`
  CONSTRAINT market_dataset_verifications_confidence_shape CHECK (confidence <> 'verified' OR status = 'verified'),
  -- drift is said, never implied
  CONSTRAINT market_dataset_verifications_drift_shape CHECK (status <> 'drifted' OR (drift IS NOT NULL AND length(drift) > 0)),
  CONSTRAINT market_dataset_verifications_key_shape CHECK (dataset_key = host || '/' || dataset_id)
);

COMMENT ON TABLE public.market_dataset_verifications IS
  'Wave 148 (148F, owner ruling 6, contract C19): one verification observation per market-registry dataset — source, licence, geography, coverage, freshness, last_verified_at, confidence (the ceiling it lends: verified | unknown), data_rights, drift, verified_by. Writer lib/intent/dataset-verification.ts recordDatasetObservations (the daily permit sweep); the latest row per dataset_key (by observed_at) overlays the code contract. Platform-scoped public-data metadata (no brokerage_id).';

CREATE INDEX IF NOT EXISTS market_dataset_verifications_latest_idx ON public.market_dataset_verifications (dataset_key, observed_at DESC);

ALTER TABLE public.market_dataset_verifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS market_dataset_verifications_authenticated_read ON public.market_dataset_verifications;
CREATE POLICY market_dataset_verifications_authenticated_read ON public.market_dataset_verifications
  FOR SELECT TO authenticated
  USING (true);

REVOKE INSERT, UPDATE, DELETE ON public.market_dataset_verifications FROM authenticated, anon;
GRANT SELECT ON public.market_dataset_verifications TO authenticated;

-- ── VERIFY (integrator, after apply) ─────────────────────────────────────────────────────────────────────────────────────────
-- 1. SELECT to_regclass('public.market_dataset_verifications');                                  -- not null
-- 2. INSERT ... status='stale', confidence='verified'  → refused by market_dataset_verifications_confidence_shape (23514)
-- 3. INSERT ... status='drifted', drift=NULL           → refused by market_dataset_verifications_drift_shape (23514)
-- 4. INSERT ... dataset_key <> host || '/' || dataset_id → refused by market_dataset_verifications_key_shape (23514)
-- 5. SELECT relrowsecurity FROM pg_class WHERE relname = 'market_dataset_verifications';         -- true
-- Then regenerate scripts/schema-snapshot.ts, scripts/live-tables.ts and scripts/check-vocabularies.ts (5 CHECK vocabularies:
-- provider, kind, confidence, status, method).
