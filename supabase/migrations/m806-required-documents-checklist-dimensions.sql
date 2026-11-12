-- ── APPLIED LIVE 2026-10-24 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 143, lane 143B; statement by statement where the MCP held a batch ──
--
-- m806 — THE BROKERAGE'S REQUIRED-DOCUMENT CHECKLIST LEARNS FIVE DIMENSIONS
--
-- Owner (wave 143): "The brokerage gives the COMPLETE list of required documents for each
-- contract type, for compliance including closing."
--
-- brokerage_required_documents could select a rule by scope, deal side (deal_type) and state_code.
-- It could not say WHEN a document is due, whether the deal is CASH or FINANCED, what KIND of
-- contract it is, or which representation model applies — so the closing file had no checklist of
-- its own, and a brokerage could not require proof of funds on cash deals only.
--
-- ADDITIVE AND INERT: every column is nullable (NULL = "any") except policy_version (default 1), so
-- every existing row keeps meaning exactly what it meant. lib/compliance/checklist-dimensions.ts
-- (rowApplicability) is the ONE reader of the four dimension columns; the resolver uses select('*'),
-- so it works before AND after this is applied.
--
-- Verified against the live database before writing (2026-10-23, project hrvaqgvukzxfskkcrwbt):
--   · brokerage_required_documents carries ONLY a pkey, two non-unique indexes
--     (brd_by_classification_idx, brd_resolver_idx) and the CHECKs brd_classification_check,
--     brd_deal_type_check, brokerage_required_documents_scope_type_check — NO unique constraint over
--     the dedupe key, so two rows that differ only in a new dimension are admissible.
--   · none of the five column names exists on the table.
--
-- CHECK vocabularies (mirrored by lib/compliance/checklist-dimensions.ts; scripts/closing-compliance-guard.ts
-- holds the two equal — regenerate scripts/check-vocabularies.ts after applying):
--   required_stage    listing | offer | contract | closing
--   financing_kind    cash | financed
--   contract_subtype  standard | new_construction | short_sale | reo_bank_owned | probate_estate | lease_option
--   representation    single_agency | dual_agency | designated_agency | transaction_brokerage

ALTER TABLE public.brokerage_required_documents
  ADD COLUMN IF NOT EXISTS required_stage   text,
  ADD COLUMN IF NOT EXISTS financing_kind   text,
  ADD COLUMN IF NOT EXISTS contract_subtype text,
  ADD COLUMN IF NOT EXISTS representation   text,
  ADD COLUMN IF NOT EXISTS policy_version   integer NOT NULL DEFAULT 1;

ALTER TABLE public.brokerage_required_documents
  ADD CONSTRAINT brd_required_stage_check
    CHECK (required_stage IS NULL OR required_stage IN ('listing','offer','contract','closing')),
  ADD CONSTRAINT brd_financing_kind_check
    CHECK (financing_kind IS NULL OR financing_kind IN ('cash','financed')),
  ADD CONSTRAINT brd_contract_subtype_check
    CHECK (contract_subtype IS NULL OR contract_subtype IN ('standard','new_construction','short_sale','reo_bank_owned','probate_estate','lease_option')),
  ADD CONSTRAINT brd_representation_check
    CHECK (representation IS NULL OR representation IN ('single_agency','dual_agency','designated_agency','transaction_brokerage')),
  ADD CONSTRAINT brd_policy_version_check
    CHECK (policy_version >= 1);

-- ── PART 2 — closing-compliance rows are ONE per (transaction, check) ─────────────────────────────────────
-- lib/transactions/closing-compliance.ts files its findings in transaction_compliance_log as check_type
-- 'closing_terms.*' / 'closing_docs.*' / 'closing_participants.*' (the table the compliance tab and
-- canProceedToClosingPrep already read). Two scans of one transaction can land together; this partial unique
-- index makes the second INSERT lose (23505) so the writer re-reads and reconciles instead of duplicating a
-- row. It touches ONLY closing_* rows: every existing check_type is outside the predicate. Verified live
-- (2026-10-23): transaction_compliance_log has no unique constraint at all and check_type has no CHECK.
CREATE UNIQUE INDEX IF NOT EXISTS transaction_compliance_log_closing_one_per_check
  ON public.transaction_compliance_log (transaction_id, check_type)
  WHERE check_type LIKE 'closing\_terms.%' OR check_type LIKE 'closing\_docs.%' OR check_type LIKE 'closing\_participants.%';

COMMENT ON COLUMN public.brokerage_required_documents.required_stage IS
  'WHEN the document is due (cumulative "due by"): listing < offer < contract < closing. NULL = any stage (every pre-m806 row).';
COMMENT ON COLUMN public.brokerage_required_documents.financing_kind IS
  'cash | financed. NULL = any. A rule naming a kind the caller cannot confirm applies as a WARNING, never as "not required".';
COMMENT ON COLUMN public.brokerage_required_documents.policy_version IS
  'Bumped by app/actions/compliance/manage-required-docs.ts on every edit of the rule. AuditResult.checklist_fingerprint cites id@version of every rule that answered.';
