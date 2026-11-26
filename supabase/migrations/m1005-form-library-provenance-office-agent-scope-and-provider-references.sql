-- ── APPLIED LIVE 2026-11-25 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) (wave 156, lane 156C) — applied by the integrator; additive ──
--
-- m1005 — EVERY FORM IN THE LIBRARY CARRIES ITS PROVENANCE, ITS FULL OWNER, ITS JURISDICTION, ITS REVISION AND ITS REPLACEMENT;
--         A CONNECTED-PROVIDER FORM IS A REFERENCE, NEVER A COPY OF THE PROVIDER'S BYTES.
--
-- Owner (wave 156): "the form packet tool should list all possible forms/packets or have the capability for the user or manager to
-- add more" … "Each uploaded/selected form has provenance, owner, tenant/office scope, jurisdiction, revision, checksum, status,
-- storage path, licensing and retired replacement."
--
-- AUDIT FIRST (CLAUDE.md §1 — extend the survivor): public.brokerage_form_library IS the tenant form registry (m853/m854: brokerage_id
-- NOT NULL, team_id, storage_path under the owner, license_note / license_expires_at, version, is_active; 0 live rows read 2026-11-25).
-- MISSING, and nothing else can hold it:
--   · an OFFICE owner (public.locations is the office; users / teams / agents / listings already carry location_id) and an AGENT's
--     own supplemental form (scope_user_id) — the registry knew brokerage and team only;
--   · provenance: source_kind, rights_basis, purpose, county, effective_on, revision_date, checklist_keys, signer_roles,
--     field_mapping, checksum_sha256 of the stored master;
--   · a connected-provider form REFERENCE (provider_name, provider_form_id, provider_form_version) with NO stored bytes;
--   · the retired form's replacement (replaced_by_id) and when it was retired (retired_at).
--
-- WHAT THIS ADDS (additive only: nullable columns, CHECKs on the NEW columns only, indexes). Nothing existing is narrowed:
--   · the CHECK vocabularies are mirrored by code constants in lib/forms/form-directory-intake.ts (FORM_LIBRARY_SOURCE_KINDS,
--     FORM_RIGHTS_BASES, FORM_PURPOSES) — ONE vocabulary per function (CLAUDE.md §6);
--   · brokerage_form_library_provider_reference_holds_no_bytes: a row that references a provider form stores NO master — the
--     provider's PDF stays with the provider (directive: never copy provider-owned bytes into storage the tenant has no right to use);
--   · one LIVE reference per provider form per owner (partial unique index) — adopting the same provider form twice is the same row.
--
-- NOT HERE (owner SQL, reported by the lane): the existing SELECT policy brokerage_form_library_tenant_select and the m854 storage
-- arm do not yet read location_id / scope_user_id. Every product read goes through the service client AFTER the code gate
-- (lib/forms/tenant-form-packets.ts packetVisibleTo, which does read them); narrowing the authenticated policies is an ALTER POLICY on
-- an existing table and is held as owner SQL.

ALTER TABLE public.brokerage_form_library
  ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS scope_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_kind text,
  ADD COLUMN IF NOT EXISTS rights_basis text,
  ADD COLUMN IF NOT EXISTS purpose text,
  ADD COLUMN IF NOT EXISTS county text,
  ADD COLUMN IF NOT EXISTS effective_on date,
  ADD COLUMN IF NOT EXISTS revision_date date,
  ADD COLUMN IF NOT EXISTS checklist_keys text[],
  ADD COLUMN IF NOT EXISTS signer_roles text[],
  ADD COLUMN IF NOT EXISTS field_mapping jsonb,
  ADD COLUMN IF NOT EXISTS checksum_sha256 text,
  ADD COLUMN IF NOT EXISTS provider_name text,
  ADD COLUMN IF NOT EXISTS provider_form_id text,
  ADD COLUMN IF NOT EXISTS provider_form_version text,
  ADD COLUMN IF NOT EXISTS replaced_by_id uuid REFERENCES public.brokerage_form_library(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retired_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brokerage_form_library_source_kind_check') THEN
    ALTER TABLE public.brokerage_form_library ADD CONSTRAINT brokerage_form_library_source_kind_check
      CHECK (source_kind IS NULL OR source_kind = ANY (ARRAY['brokerage_upload','agent_upload','state_preconfigured','connected_provider','platform_catalogue']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brokerage_form_library_rights_basis_check') THEN
    ALTER TABLE public.brokerage_form_library ADD CONSTRAINT brokerage_form_library_rights_basis_check
      CHECK (rights_basis IS NULL OR rights_basis = ANY (ARRAY['own_form','association_membership','provider_license','state_mandated_public','platform_catalogue_license']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brokerage_form_library_purpose_check') THEN
    ALTER TABLE public.brokerage_form_library ADD CONSTRAINT brokerage_form_library_purpose_check
      CHECK (purpose IS NULL OR purpose = ANY (ARRAY['listing','buyer_representation','offer','counter_offer','addendum','price_change','inspection','disclosure','agency','compliance','closing','other']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brokerage_form_library_checksum_sha256_check') THEN
    ALTER TABLE public.brokerage_form_library ADD CONSTRAINT brokerage_form_library_checksum_sha256_check
      CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brokerage_form_library_provider_reference_holds_no_bytes') THEN
    ALTER TABLE public.brokerage_form_library ADD CONSTRAINT brokerage_form_library_provider_reference_holds_no_bytes
      CHECK (provider_form_id IS NULL OR (storage_path IS NULL AND provider_name IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brokerage_form_library_one_owner') THEN
    ALTER TABLE public.brokerage_form_library ADD CONSTRAINT brokerage_form_library_one_owner
      CHECK (num_nonnulls(team_id, location_id, scope_user_id) <= 1);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_brokerage_form_library_location ON public.brokerage_form_library (brokerage_id, location_id) WHERE location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_brokerage_form_library_scope_user ON public.brokerage_form_library (brokerage_id, scope_user_id) WHERE scope_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_brokerage_form_library_checksum ON public.brokerage_form_library (brokerage_id, checksum_sha256) WHERE checksum_sha256 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_brokerage_form_library_live_provider_reference
  ON public.brokerage_form_library (
    brokerage_id, provider_name, provider_form_id,
    COALESCE(team_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(scope_user_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_active AND provider_form_id IS NOT NULL;

COMMENT ON COLUMN public.brokerage_form_library.provider_form_id IS 'wave 156 (156C): a REFERENCE to a form in the tenant''s connected provider library — no bytes stored (brokerage_form_library_provider_reference_holds_no_bytes).';
COMMENT ON COLUMN public.brokerage_form_library.replaced_by_id IS 'wave 156 (156C): the revision that replaced this retired row (lib/forms/form-directory-intake.ts reviseLibraryForm).';
