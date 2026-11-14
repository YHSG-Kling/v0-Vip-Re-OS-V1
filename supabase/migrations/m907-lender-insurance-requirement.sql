-- ── APPLIED LIVE 2026-11-14 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 153, lane 153C ── read back: jsonb column + shape CHECK; function accepts a valid requirement, refuses an unknown coverage and any amount key
--
-- THE LENDER'S INSURANCE REQUIREMENT, ON THE LENDER'S OWN PER-DEAL ROW (wave 153, lane 153C; directive §153C C3; owner ruling 7,
-- verbatim 2026-11-14: "an insurance policy is required by the lender so that needs to be added in around the appraisal deadline
-- if it isn't already there").
--
-- CENSUS (live, read-only, 2026-11-14):
--   · transaction_vendor_services.policy (m385) — the BUYER'S bound policy (carrier, number, coverage, premium, effective, expiry,
--     binder document, bound_at, bound_by), pinned by hazard_policy_record_ok. It says what was BOUND, not what the LENDER requires
--     or whether the lender ACCEPTED the evidence. Widening it would mix two parties' facts on one record (CLAUDE.md §6). 0 live rows.
--   · transaction_lenders — the lender's per-deal row (lender_name, loan officer, appraisal dates, clear_to_close_date,
--     underwriting_status …). The requirement is the lender's fact about THIS loan, so it belongs here. 1 live row, 0 duplicates
--     per transaction. No insurance column exists.
--   · transaction_deadlines — dates only (no requirement facts); the checkpoint's date is DERIVED by the reader from the lender's
--     date or the tenant's anchor (around the appraisal deadline), so no deadline row is written.
--   So: ONE nullable jsonb column, shape-checked like m385 — the record is absent until someone states the requirement, and the
--   reader treats absence as "ask the lender", never as "not required".
--
-- THE SHAPE (keys pinned; ONE code source — lib/transactions/hazard-insurance.ts):
--   required                 boolean (absent = not stated)
--   coverages                array ⊂ LENDER_INSURANCE_COVERAGES  ('hazard','flood','wind','earthquake','other')
--   other_coverage           text
--   mortgagee_clause         text (as the lender wrote it)
--   escrow_treatment         LENDER_INSURANCE_ESCROW              ('escrowed','paid_at_closing','paid_outside_closing','unknown')
--   evidence_recipient       text
--   due_date                 yyyy-mm-dd (the lender's own deadline)
--   source                   LENDER_INSURANCE_SOURCES             ('lender_portal','agent_reported','tc_reported')
--   recorded_by / recorded_at
--   evidence_verified_at / evidence_verified_by / evidence_document_id
--   evidence_verified_source LENDER_INSURANCE_VERIFIERS           ('lender_portal','staff_review')
-- No amount key exists on purpose: a coverage amount is never asserted by the platform.
--
-- ROLLBACK: ALTER TABLE public.transaction_lenders DROP CONSTRAINT IF EXISTS transaction_lenders_insurance_requirement_shape;
--           DROP FUNCTION IF EXISTS public.lender_insurance_requirement_ok(jsonb);
--           ALTER TABLE public.transaction_lenders DROP COLUMN IF EXISTS insurance_requirement;   -- owner SQL (DROP COLUMN)

BEGIN;

ALTER TABLE public.transaction_lenders ADD COLUMN IF NOT EXISTS insurance_requirement jsonb;

CREATE OR REPLACE FUNCTION public.lender_insurance_requirement_ok(rec jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT rec IS NULL
      OR ( jsonb_typeof(rec) = 'object'
       AND (rec - 'required' - 'coverages' - 'other_coverage' - 'mortgagee_clause' - 'escrow_treatment' - 'evidence_recipient'
                - 'due_date' - 'source' - 'recorded_by' - 'recorded_at' - 'evidence_verified_at' - 'evidence_verified_by'
                - 'evidence_verified_source' - 'evidence_document_id') = '{}'::jsonb
       AND (rec -> 'required' IS NULL OR jsonb_typeof(rec -> 'required') = 'boolean')
       AND (rec -> 'coverages' IS NULL
            OR (jsonb_typeof(rec -> 'coverages') = 'array'
                AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(rec -> 'coverages') c
                                WHERE c NOT IN ('hazard', 'flood', 'wind', 'earthquake', 'other'))))
       AND (rec ->> 'escrow_treatment' IS NULL OR rec ->> 'escrow_treatment' IN ('escrowed', 'paid_at_closing', 'paid_outside_closing', 'unknown'))
       AND (rec ->> 'source' IS NULL OR rec ->> 'source' IN ('lender_portal', 'agent_reported', 'tc_reported'))
       AND (rec ->> 'evidence_verified_source' IS NULL OR rec ->> 'evidence_verified_source' IN ('lender_portal', 'staff_review'))
       AND (rec ->> 'due_date' IS NULL OR rec ->> 'due_date' ~ '^\d{4}-\d{2}-\d{2}$')
       AND (rec ->> 'mortgagee_clause' IS NULL OR char_length(rec ->> 'mortgagee_clause') <= 1000)
       AND (rec ->> 'other_coverage' IS NULL OR char_length(rec ->> 'other_coverage') <= 200)
       AND (rec ->> 'evidence_recipient' IS NULL OR char_length(rec ->> 'evidence_recipient') <= 300) )
$function$;

ALTER TABLE public.transaction_lenders DROP CONSTRAINT IF EXISTS transaction_lenders_insurance_requirement_shape;
ALTER TABLE public.transaction_lenders
  ADD CONSTRAINT transaction_lenders_insurance_requirement_shape CHECK (public.lender_insurance_requirement_ok(insurance_requirement));

COMMENT ON COLUMN public.transaction_lenders.insurance_requirement IS 'wave 153 (153C): the lender''s insurance requirement for this loan (required, coverages, mortgagee clause, escrow treatment, evidence recipient, due date, source) and whether the evidence was accepted. Absent = not stated (coach the agent to ask). Writer: lib/transactions/lender-insurance-checkpoint.ts.';

COMMIT;

-- After apply (integrator): regenerate scripts/schema-snapshot.ts (transaction_lenders.insurance_requirement).
-- Read-back:
--   SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'transaction_lenders' AND column_name = 'insurance_requirement';
--   SELECT public.lender_insurance_requirement_ok('{"required":true,"coverages":["hazard","flood"],"source":"lender_portal"}'::jsonb) AS ok_true,
--          public.lender_insurance_requirement_ok('{"required":"yes"}'::jsonb) AS ok_false,
--          public.lender_insurance_requirement_ok('{"coverage_amount":500000}'::jsonb) AS amount_refused;
