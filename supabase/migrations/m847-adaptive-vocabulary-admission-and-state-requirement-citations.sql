-- WRITTEN, NOT APPLIED (wave 144, lane 144A) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN are owner SQL-editor
--
-- m847 — THE ADAPTIVE VOCABULARY REACHES THE DATABASE, AND A STATE REQUIREMENT CARRIES ITS CITATION
--
-- Owner ruling 1 (wave 144): contract subtype, financing and representation must be SELF-HEALING — a brokerage
-- or a state may use a label the platform list does not have; it travels the approved proposal path and lands
-- in the brokerage's canonical configuration (tenant policy key `adaptive_vocabulary`, brokerage_settings.settings,
-- lib/compliance/adaptive-vocabulary.ts). "Live CHECK constraints that would reject a new label are a finding."
--
-- THE FINDING. m806's brd_contract_subtype_check and brd_representation_check pin brokerage_required_documents to
-- the PLATFORM lists, so an approved brokerage term ("intermediary" in Texas) can never be named by a required-document
-- rule: the INSERT is refused 23514 and the rule is lost. This migration MOVES that enforcement to the vocabulary —
-- it does not widen the CHECK: a value is admitted when it is a platform value (the same arrays m806 wrote, held equal
-- to lib/compliance/checklist-dimensions.ts by scripts/adaptive-vocabulary-guard.ts) OR a term stored in THAT
-- brokerage's own adaptive vocabulary. Anything else is still refused 23514, exactly as before.
--
-- Verified against the live database before writing (2026-10-25, project hrvaqgvukzxfskkcrwbt):
--   · brokerage_required_documents: 7 rows, 0 with contract_subtype or representation set; one trigger
--     (trg_brd_updated_at BEFORE UPDATE → set_brd_updated_at); CHECKs brd_contract_subtype_check,
--     brd_representation_check, brd_financing_kind_check, brd_required_stage_check, brd_classification_check,
--     brd_deal_type_check, brd_policy_version_check, brokerage_required_documents_scope_type_check; FKs brokerage_id,
--     created_by (users ON DELETE SET NULL), template_form_id.
--   · brokerage_settings: UNIQUE (brokerage_id); settings is jsonb; RLS SELECT/UPDATE = is_platform_admin() OR
--     (is_brokerage_admin() AND has_brokerage_access(brokerage_id)) — an AGENT cannot read it, which is why the
--     vocabulary gets its own reader below (every member of the brokerage may read the vocabulary, nothing else).
--   · has_brokerage_access(uuid), is_platform_admin() exist (SECURITY DEFINER).
--   · none of the column, function or trigger names below exists.
--
-- PART A is additive and inert until a brokerage has a term. PART B (dropping the two CHECKs) is separate on
-- purpose: apply it only after PART A is verified live. Until PART B, the CHECK still refuses a brokerage term and
-- app/actions/compliance/manage-required-docs.ts reports the refusal — fail closed, never a silent wildcard.
--
-- AFTER APPLYING: regenerate scripts/check-vocabularies.ts (PART B removes two single-column CHECKs, PART A adds
-- brd_legal_basis_check), scripts/schema-snapshot.ts (six columns) and scripts/schema-fk-map.ts (approved_by → users).

-- ══════════════════════════════ PART A1 — the vocabulary admission (one function, read by the trigger) ══════════════════════════════

CREATE OR REPLACE FUNCTION public.adaptive_vocabulary_admits(p_brokerage_id uuid, p_dimension text, p_value text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_value IS NULL
      OR p_value = ANY (CASE p_dimension
           WHEN 'contract_subtype' THEN ARRAY['standard','new_construction','short_sale','reo_bank_owned','probate_estate','lease_option']
           WHEN 'representation'   THEN ARRAY['single_agency','dual_agency','designated_agency','transaction_brokerage']
           ELSE ARRAY[]::text[] END)
      OR EXISTS (
           SELECT 1 FROM public.brokerage_settings bs
            WHERE bs.brokerage_id = p_brokerage_id
              AND jsonb_typeof(bs.settings -> 'adaptive_vocabulary' -> 'terms') = 'object'
              AND (bs.settings -> 'adaptive_vocabulary' -> 'terms') ? (p_dimension || ':' || p_value)
              AND (bs.settings -> 'adaptive_vocabulary' -> 'terms' -> (p_dimension || ':' || p_value) ->> 'key') = p_value)
$$;

COMMENT ON FUNCTION public.adaptive_vocabulary_admits(uuid, text, text) IS
  'm847: a platform value (the m806 arrays, held equal to lib/compliance/checklist-dimensions.ts) or a term in THIS brokerage''s adaptive vocabulary (brokerage_settings.settings.adaptive_vocabulary.terms, key <dimension>:<key>). A retired term stays admitted — history never breaks; new rules are gated by the app.';

REVOKE ALL ON FUNCTION public.adaptive_vocabulary_admits(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adaptive_vocabulary_admits(uuid, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.brd_vocabulary_admission()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.contract_subtype IS NOT NULL AND NOT public.adaptive_vocabulary_admits(NEW.brokerage_id, 'contract_subtype', NEW.contract_subtype) THEN
    RAISE EXCEPTION 'contract_subtype "%" is neither a platform contract type nor a term in this brokerage''s vocabulary', NEW.contract_subtype
      USING ERRCODE = '23514', CONSTRAINT = 'brd_contract_subtype_vocabulary';
  END IF;
  IF NEW.representation IS NOT NULL AND NOT public.adaptive_vocabulary_admits(NEW.brokerage_id, 'representation', NEW.representation) THEN
    RAISE EXCEPTION 'representation "%" is neither a platform representation nor a term in this brokerage''s vocabulary', NEW.representation
      USING ERRCODE = '23514', CONSTRAINT = 'brd_representation_vocabulary';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_brd_vocabulary_admission ON public.brokerage_required_documents;
CREATE TRIGGER trg_brd_vocabulary_admission
  BEFORE INSERT OR UPDATE OF contract_subtype, representation, brokerage_id ON public.brokerage_required_documents
  FOR EACH ROW EXECUTE FUNCTION public.brd_vocabulary_admission();

-- ══════════════════════════════ PART A2 — the vocabulary reader any member of the brokerage may call ══════════════════════════════
-- lib/compliance/adaptive-vocabulary.ts loadTenantVocabulary calls it first (PGRST202 before this is applied → it falls
-- back to the service-client read). It returns ONLY the vocabulary value — never another settings key (the table holds
-- provider tokens). A caller without access is REFUSED (42501), never handed an empty vocabulary.

CREATE OR REPLACE FUNCTION public.tenant_adaptive_vocabulary(p_brokerage_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR public.is_platform_admin() OR public.has_brokerage_access(p_brokerage_id)) THEN
    RAISE EXCEPTION 'not a member of this brokerage' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT bs.settings -> 'adaptive_vocabulary' FROM public.brokerage_settings bs WHERE bs.brokerage_id = p_brokerage_id);
END
$$;

REVOKE ALL ON FUNCTION public.tenant_adaptive_vocabulary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tenant_adaptive_vocabulary(uuid) TO authenticated, service_role;

-- ══════════════════════════════ PART A3 — a STATE REQUIREMENT carries its citation and its approver ══════════════════════════════
-- Owner ruling 1: "state-specific regulatory document rules need human compliance approval and verified official
-- sources — AI never invents binding legal requirements." A rule that says the STATE requires a document must name the
-- state, cite an official publisher (.gov / .us — the same test as lib/compliance-rules/law-rule-registry.ts
-- isPrimarySourceUrl) and record who approved it. NULL legal_basis = the brokerage's own policy (every existing row,
-- and every preset seed — the presets are common practice, not citations). Writer: manage-required-docs.ts addRequiredDocument
-- (compliance approver only); reader: lib/compliance/required-documents.ts (legal_basis / source_url on the resolved rule)
-- and the settings list.

ALTER TABLE public.brokerage_required_documents
  ADD COLUMN IF NOT EXISTS legal_basis        text,
  ADD COLUMN IF NOT EXISTS source_url         text,
  ADD COLUMN IF NOT EXISTS source_title       text,
  ADD COLUMN IF NOT EXISTS source_verified_on date,
  ADD COLUMN IF NOT EXISTS approved_by        uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at        timestamptz;

ALTER TABLE public.brokerage_required_documents
  ADD CONSTRAINT brd_legal_basis_check
    CHECK (legal_basis IS NULL OR legal_basis IN ('brokerage_policy','state_requirement')),
  ADD CONSTRAINT brd_state_requirement_cited_check
    CHECK (legal_basis IS DISTINCT FROM 'state_requirement'
           OR (state_code IS NOT NULL
               AND source_url ~* '^https?://[^/?#:@]+\.(gov|us)([/?#:]|$)'
               AND approved_by IS NOT NULL
               AND approved_at IS NOT NULL));

COMMENT ON COLUMN public.brokerage_required_documents.legal_basis IS
  'm847: state_requirement = a STATE requires the document (state_code + an official .gov/.us source_url + approved_by a compliance approver); brokerage_policy / NULL = the brokerage''s own rule.';

-- ══════════════════════════════ PART B — move the two CHECKs onto the vocabulary (apply after PART A is verified) ══════════════════════════════
-- The trigger above refuses exactly what these CHECKs refused, plus admits the brokerage's own approved terms.

ALTER TABLE public.brokerage_required_documents DROP CONSTRAINT IF EXISTS brd_contract_subtype_check;
ALTER TABLE public.brokerage_required_documents DROP CONSTRAINT IF EXISTS brd_representation_check;
