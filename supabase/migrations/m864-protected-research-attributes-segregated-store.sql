-- WRITTEN, NOT APPLIED (wave 145, lane 145F) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN and storage.objects policies are owner SQL-editor
--
-- m864 — THE SEGREGATED RESEARCH HOME FOR PROTECTED / SENSITIVE ENRICHMENT FIELDS (owner ruling 12, wave 145).
--
-- Owner, verbatim: "There should be no protected fair housing protected attributes holding back any enrichment syncing as it is a
-- major road block when needing that research." Wave ruling: enrichment syncing proceeds; sensitive / protected fields are STORED
-- under access control + provenance for authorized research, SEGREGATED from housing targeting, never exposed to ads / steering /
-- eligibility. Do not block import; do not expose.
--
-- WHAT WAS THERE: the sync was never blocked (lib/lead-governance/protected-class-signals.ts LABELS, never strips, since wave 15),
-- but the Versium full_demographic adapter (lib/external/versium-client.ts appendVersiumRealEstateIndicators) BOUGHT the whole row
-- (3 match credits) and DISCARDED every protected field in it (ethnicity, religion, language, household composition, gender, age
-- bands, veteran-in-household, party affiliation, health) — the research the owner needs was paid for and thrown away. Lanes 144E /
-- 144Z left the research-only home as a PENDING owner decision (separate table vs a role-restricted read of contacts columns).
--
-- THIS MIGRATION builds the SEPARATE-TABLE option (the only one that segregates: a contacts column is readable by every agent who
-- can read the contact row, and by every targeting module that selects `*`). It holds:
--   · one row per (contact, provider, verbatim vendor field) — the vendor's OWN field name, never re-mapped onto a contacts column;
--   · the protected CLASS the field bears (one vocabulary, CHECKed), the BASIS (a vendor-MODELED value is never a self-identified
--     fact), the PROVENANCE (provider, capability, retrieved_at, match confidence), first-observed / value-changed stamps;
--   · purpose fixed to 'research' (CHECK) — there is no other lawful purpose for this table.
-- ACCESS (fail closed, the narrowest defensible default while the owner's role decision is pending):
--   · RLS ON; anon has nothing; authenticated may SELECT only as platform staff (public.is_platform_staff()) or as a
--     compliance_officer of the SAME brokerage (public.current_user_type(), public.current_user_brokerage_id() — the existing
--     access-control helpers, SECURITY DEFINER);
--   · NO insert / update / delete policy: only the service role (the enrichment writer, lib/enrichment/protected-research-store.ts)
--     writes. No ads / targeting / dispatch module reads it (guarded: scripts/lifetime-signals-guard.ts).
-- STILL THE OWNER'S: which roles may read it (compliance_officer and platform staff today), and the retention period
-- (retain_until stays NULL — no invented number — until the owner sets one).

CREATE TABLE IF NOT EXISTS public.protected_research_attributes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id       uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  contact_id         uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  provider           text NOT NULL,
  capability         text NOT NULL,
  source_field       text NOT NULL,
  attribute_value    text NOT NULL,
  attribute_class    text NOT NULL,
  basis              text NOT NULL DEFAULT 'vendor_modeled',
  purpose            text NOT NULL DEFAULT 'research',
  match_confidence   text,
  retrieved_at       timestamptz NOT NULL,
  first_observed_at  timestamptz NOT NULL DEFAULT now(),
  value_changed_at   timestamptz NOT NULL DEFAULT now(),
  retain_until       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT protected_research_attributes_class_check CHECK (attribute_class IN (
    'race_color_national_origin', 'language', 'religion', 'familial_status', 'sex', 'age', 'disability_health',
    'military_status', 'political_affiliation'
  )),
  CONSTRAINT protected_research_attributes_basis_check CHECK (basis IN ('vendor_modeled', 'self_identified', 'public_record')),
  CONSTRAINT protected_research_attributes_purpose_check CHECK (purpose = 'research'),
  CONSTRAINT protected_research_attributes_one_field UNIQUE (contact_id, provider, source_field)
);

CREATE INDEX IF NOT EXISTS idx_protected_research_attributes_tenant
  ON public.protected_research_attributes (brokerage_id, contact_id);

ALTER TABLE public.protected_research_attributes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.protected_research_attributes FROM anon;
REVOKE ALL ON public.protected_research_attributes FROM authenticated;
GRANT SELECT ON public.protected_research_attributes TO authenticated;

DROP POLICY IF EXISTS protected_research_attributes_research_read ON public.protected_research_attributes;
CREATE POLICY protected_research_attributes_research_read ON public.protected_research_attributes
  FOR SELECT TO authenticated
  USING (
    public.is_platform_staff()
    OR (brokerage_id = public.current_user_brokerage_id() AND public.current_user_type() = 'compliance_officer')
  );

COMMENT ON TABLE public.protected_research_attributes IS
  'Wave 145 (lane 145F, owner ruling 12): protected / sensitive enrichment fields stored for AUTHORIZED RESEARCH only — segregated from contacts, never read by ads / targeting / dispatch / eligibility. Service-role writes only; SELECT for platform staff or a same-tenant compliance_officer. Retention: owner decision pending (retain_until NULL).';

-- VERIFY (read-only, after apply):
--   SELECT relrowsecurity FROM pg_class WHERE oid = 'public.protected_research_attributes'::regclass;            -- → true
--   SELECT policyname, cmd FROM pg_policies WHERE tablename = 'protected_research_attributes';                    -- → one SELECT policy
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.protected_research_attributes'::regclass ORDER BY 1; -- → 3 CHECKs + UNIQUE + 2 FK + PK
