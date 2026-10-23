-- WRITTEN, NOT APPLIED (wave 143, lane 143F) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN are owner SQL-editor
--
-- m846 — older_persons_housing_verifications (wave 143, lane 143F: the HOUSING-FOR-OLDER-PERSONS exemption).
-- Writer: lib/compliance/fair-housing-older-persons-store.ts saveOlderPersonsVerification, reached ONLY through the
-- tenant-admin server action app/actions/fair-housing-older-persons.ts (session tenant, admin roster, ledger row
-- compliance.older_persons.verify). Readers: loadOlderPersonsVerifications — publishLeadMagnet, the lead-magnet AI draft,
-- the book creator, the video-script assessment, the podcast auto-producer, and the settings panel
-- (app/components/compliance/OlderPersonsExemptionPanel.tsx on /compliance/settings).
--
-- WHY A NEW TABLE (orphan doctrine §1.2 — audited against the live schema 2026-10-23; no table named *senior* / *exempt* /
-- *hopa* / *older* / *community* holds this): the facts are per-COMMUNITY attestations with dates and a two-year clock
-- (24 CFR 100.307), not a policy toggle — brokerage_settings.settings (the tenant-policy survivor) holds switches and has no
-- per-row history, RLS granularity or ledger-friendly identity. prohibited_phrases is a phrase catalogue, not an attestation.
--
-- WHAT IT RECORDS (42 U.S.C. § 3607(b)(2)-(3); 24 CFR 100.300-100.308, read 2026-10-23): the basis (55+, 62+, or a State/
-- Federal elderly-housing programme), the community and its governing rules, the 80-percent count over OCCUPIED units, the
-- published-policies reference, the age-verification procedures and the date of the last occupancy survey (refreshed at
-- least every two years), the § 100.308 sworn certification, and a human attestation that the state's own senior-housing
-- rules were reviewed. `status` is COMPUTED by the application from those facts (verified | conditions_unmet) — the CHECK
-- only keeps the vocabulary closed; the caller cannot assert "verified".
--
-- Until applied: loadOlderPersonsVerifications is refused (42P01) and returns "unreadable", which HOLDS every age-qualified
-- claim (fail closed) — copy that does not claim 55+/62+/senior housing is unaffected.
-- After applying: regenerate schema-snapshot, live-tables, the FK map AND scripts/check-vocabularies.ts (two new CHECKs
-- below), and add TABLE_MANAGER 'older_persons_housing_verifications' -> compliance_officer in lib/kernel/manager-registry.ts.

-- PART 1 — table (apply first).
CREATE TABLE IF NOT EXISTS public.older_persons_housing_verifications (
  id                           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id                 uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  community_name               text        NOT NULL,
  -- lower-case alphanumerics, space-separated — the dedup + match key (lib/compliance/fair-housing-older-persons.ts communityKey)
  community_key                text        NOT NULL,
  basis                        text        NOT NULL
    CONSTRAINT older_persons_housing_verifications_basis_check
    CHECK (basis IN ('55_plus', '62_plus', 'federal_state_program')),
  governing_rules              text        NULL,
  occupied_units               integer     NULL CHECK (occupied_units IS NULL OR occupied_units >= 0),
  qualifying_units             integer     NULL CHECK (qualifying_units IS NULL OR qualifying_units >= 0),
  survey_completed_on          date        NULL,
  policies_published           boolean     NOT NULL DEFAULT false,
  policies_reference           text        NULL,
  age_verification_procedures  boolean     NOT NULL DEFAULT false,
  program_name                 text        NULL,
  program_determination_ref    text        NULL,
  sworn_certification_on_file  boolean     NOT NULL DEFAULT false,
  certifying_representative    text        NULL,
  certification_date           date        NULL,
  state                        text        NULL CHECK (state IS NULL OR state ~ '^[A-Z]{2}$'),
  state_law_reviewed           boolean     NOT NULL DEFAULT false,
  status                       text        NOT NULL
    CONSTRAINT older_persons_housing_verifications_status_check
    CHECK (status IN ('verified', 'conditions_unmet')),
  -- survey + 2 years (55+), verification + 2 years (62+ / programme): after this date the claim is held again.
  expires_on                   date        NULL,
  verified_by                  uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  verified_at                  timestamptz NOT NULL DEFAULT now(),
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT older_persons_housing_verifications_units_check
    CHECK (qualifying_units IS NULL OR occupied_units IS NULL OR qualifying_units <= occupied_units)
);

COMMENT ON TABLE public.older_persons_housing_verifications IS
  'Wave 143 (143F): a tenant''s recorded attestation that a named community is housing for older persons (42 U.S.C. 3607(b); 24 CFR 100.300-100.308). status is computed by the application from the recorded conditions; a 55+/62+/senior-housing claim in public copy passes only against a verified, unexpired record that the copy names. Writer: lib/compliance/fair-housing-older-persons-store.ts via app/actions/fair-housing-older-persons.ts.';

-- PART 2 — indexes + RLS (apply after part 1).
CREATE UNIQUE INDEX IF NOT EXISTS older_persons_housing_verifications_tenant_community_uidx
  ON public.older_persons_housing_verifications (brokerage_id, community_key);
CREATE INDEX IF NOT EXISTS older_persons_housing_verifications_tenant_expiry_idx
  ON public.older_persons_housing_verifications (brokerage_id, expires_on);

ALTER TABLE public.older_persons_housing_verifications ENABLE ROW LEVEL SECURITY;

-- Tenant members read their own brokerage's records (the session-client video-script gate reads through this);
-- writes come only through the service role behind the admin-gated server action — no INSERT/UPDATE/DELETE policy.
CREATE POLICY older_persons_housing_verifications_tenant_read ON public.older_persons_housing_verifications
  FOR SELECT TO authenticated
  USING (brokerage_id = public.current_user_brokerage_id());

REVOKE INSERT, UPDATE, DELETE ON public.older_persons_housing_verifications FROM authenticated, anon;
GRANT SELECT ON public.older_persons_housing_verifications TO authenticated;
