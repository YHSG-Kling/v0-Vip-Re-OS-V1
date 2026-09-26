-- ═══════════════════════════════════════════════════════════════════════════
-- m385 — BUYER HAZARD INSURANCE. The homeowner's policy on a buyer deal becomes
--        a tracked record with a shape the database enforces, and the marketplace
--        vendor that wrote it becomes a resolvable id instead of a typed name.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- OWNER ASK: "insurance for buyer transaction hazard build" — track the policy,
-- and recommend insurance vendors from the brokerage's own marketplace.
--
-- ── WHAT ALREADY EXISTED (the audit, so nobody re-derives it) ───────────────
-- The insurance step is HALF-BUILT, not absent. Do not add a parallel table:
--
--   · `transaction_vendor_services` ALREADY carries the deal's insurance
--     engagement as service_type='insurance_quote' — vendor_name/email/phone,
--     quote_amount, cost, quote_approved, quote_activity_id, status, notes.
--     app/actions/transaction-inspections.ts writes it; the transaction detail
--     page reads it; lib/transactions/vendor-quote-workflow.ts approves it.
--   · KernelEvent.INSURANCE_QUOTE_REQUESTED / INSURANCE_QUOTE_APPROVED exist.
--   · `insurance_quote_approved` is ALREADY a canonical milestone identity
--     (lib/transactions/milestone-identity.ts).
--   · `vendors.category` ALREADY admits 'insurance' — NO category widening is
--     needed, and none is done here.
--   · `documents.classification` / `brokerage_required_documents.classification`
--     are the ONE document vocabulary (m356). There is no binder type in it.
--
-- What is missing is the second half: a QUOTE is not a BOUND POLICY. Nothing
-- records the carrier, policy number, coverage, effective date, expiry or
-- premium of the policy the buyer actually bought, nothing links the engagement
-- to the marketplace vendor row it came from, and nothing makes the ABSENCE of
-- a policy legible before closing day. This migration closes exactly that gap
-- ON THE EXISTING ROW.
--
-- ── WHY jsonb AND NOT SEVEN COLUMNS ────────────────────────────────────────
-- `transaction_vendor_services` is generic: an inspector row, an appraiser row
-- and an insurance row all live in it. Seven carrier/policy/coverage columns
-- would be permanently NULL on every non-insurance row. m376 settled this exact
-- question for the vendor's own certificate of insurance — one nullable jsonb
-- on the existing row, with an IMMUTABLE check function pinning the field
-- vocabulary and forcing every date ISO-leading so an unreadable expiry can
-- never read as "fine". Same problem, same idiom, so the two records stay
-- legible side by side. The CHECK additionally forbids a policy on any row that
-- is not the insurance engagement, so the misuse is unrepresentable.
--
-- Live at apply time: transaction_vendor_services = 0 rows. Every constraint
-- below is free today. THAT IS WHY IT GOES IN NOW.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. THE DOCUMENT VOCABULARY: the binder / declarations page ─────────────
-- A hazard-insurance step belongs in the required-documents spine that already
-- exists, not beside it. Adding the classification here is what lets a
-- brokerage put "Insurance binder" on its own required-documents checklist
-- (app/dashboard/settings/required-documents) and have auditOfferDocuments
-- block or warn on it — with no new mechanism whatsoever.
--
-- WIDEN, never narrow: both CHECKs are rebuilt with the full existing list plus
-- one member. lib/compliance/document-classifications.ts MIRRORS this list; a
-- member added there without this migration produces a value PostgREST refuses
-- and RESOLVES, i.e. a silent write failure.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_classification_check;
ALTER TABLE documents ADD CONSTRAINT documents_classification_check
  CHECK (classification IS NULL OR classification = ANY (ARRAY[
    'pre_approval_letter', 'proof_of_funds', 'id_document',
    'signed_contract', 'counter_offer', 'addendum',
    'disclosure', 'inspection_report', 'appraisal_report',
    'title_report', 'hoa_documents', 'closing_disclosure',
    'wire_instructions', 'agency_disclosure', 'commission_agreement',
    'lender_letter', 'earnest_money_receipt',
    'listing_agreement', 'seller_broker_agreement',
    'preliminary_closing_statement',
    'insurance_binder',          -- m385
    'other'
  ]::text[]));

ALTER TABLE brokerage_required_documents DROP CONSTRAINT IF EXISTS brd_classification_check;
ALTER TABLE brokerage_required_documents ADD CONSTRAINT brd_classification_check
  CHECK (classification = ANY (ARRAY[
    'pre_approval_letter', 'proof_of_funds', 'id_document',
    'signed_contract', 'counter_offer', 'addendum',
    'disclosure', 'inspection_report', 'appraisal_report',
    'title_report', 'hoa_documents', 'closing_disclosure',
    'wire_instructions', 'agency_disclosure', 'commission_agreement',
    'lender_letter', 'earnest_money_receipt',
    'listing_agreement', 'seller_broker_agreement',
    'preliminary_closing_statement',
    'insurance_binder',          -- m385
    'other'
  ]::text[]));

-- ── 2. THE POLICY RECORD SHAPE ─────────────────────────────────────────────
-- One bound homeowner's / hazard policy, as stored in
-- transaction_vendor_services.policy.
--
--   carrier         text   — the insurer that wrote the policy
--   policy_number   text   — the identifier on the binder / declarations page
--   coverage_amount number — dwelling coverage in whole USD, >= 0
--   annual_premium  number — premium in USD, >= 0. Absent = not known yet.
--   effective_date  date   — ISO yyyy-mm-dd, when coverage begins
--   expiry          date   — ISO yyyy-mm-dd, when coverage lapses
--   document_id     uuid   — WHICH ID SPACE: transaction_documents.id, the row
--                            holding the binder / declarations PDF. NOT
--                            documents.id. jsonb cannot carry an FK, so the id
--                            space is pinned here in writing and the writer
--                            (app/actions/transaction-hazard-insurance.ts)
--                            inserts that row itself rather than accepting an id.
--   bound_at        ts     — when the policy was recorded as bound
--   bound_by        uuid   — users.id of the person who recorded it. NOT
--                            agents.id, NOT contacts.id.
--
-- An absent key means "not on file" and is ACCEPTED. That is the honest state
-- the UI renders as "not yet provided"; forbidding it would force a caller to
-- invent a carrier or a coverage figure, which is the exact failure this lane
-- exists to prevent.
CREATE OR REPLACE FUNCTION hazard_policy_record_ok(rec jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_catalog
AS $fn$
  SELECT rec IS NULL
      OR ( jsonb_typeof(rec) = 'object'
       -- The key list IS the vocabulary. A misspelt field name (expires vs
       -- expiry) hides the date from the pre-closing detector just as surely as
       -- an absent policy, and does it while LOOKING complete — so it is
       -- rejected rather than tolerated.
       AND (rec - 'carrier' - 'policy_number' - 'coverage_amount' - 'annual_premium'
                - 'effective_date' - 'expiry' - 'document_id' - 'bound_at'
                - 'bound_by') = '{}'::jsonb
       -- Dates ISO-leading, which is exactly what Date.parse reads back
       -- deterministically. CASE, not AND: Postgres does not promise
       -- short-circuit evaluation within AND.
       AND (CASE WHEN rec ->> 'expiry'         IS NULL THEN true
                 ELSE rec ->> 'expiry'         ~ '^\d{4}-\d{2}-\d{2}' END)
       AND (CASE WHEN rec ->> 'effective_date' IS NULL THEN true
                 ELSE rec ->> 'effective_date' ~ '^\d{4}-\d{2}-\d{2}' END)
       AND (CASE WHEN rec ->> 'bound_at'       IS NULL THEN true
                 ELSE rec ->> 'bound_at'       ~ '^\d{4}-\d{2}-\d{2}' END)
       AND (CASE WHEN jsonb_typeof(rec -> 'coverage_amount') = 'number'
                 THEN (rec ->> 'coverage_amount')::numeric >= 0
                 ELSE rec -> 'coverage_amount' IS NULL END)
       AND (CASE WHEN jsonb_typeof(rec -> 'annual_premium') = 'number'
                 THEN (rec ->> 'annual_premium')::numeric >= 0
                 ELSE rec -> 'annual_premium' IS NULL END) )
$fn$;

COMMENT ON FUNCTION hazard_policy_record_ok(jsonb) IS
  'm385 — shape of transaction_vendor_services.policy (the buyer''s bound hazard / homeowner''s policy). Pins the field vocabulary and forces every date ISO-leading so lib/transactions/hazard-insurance.ts can never read an unparseable expiry as coverage in force.';

ALTER TABLE transaction_vendor_services
  ADD COLUMN IF NOT EXISTS policy jsonb;

COMMENT ON COLUMN transaction_vendor_services.policy IS
  'The BOUND hazard / homeowner''s policy for this deal: carrier, policy_number, coverage_amount, annual_premium, effective_date, expiry, document_id (transaction_documents.id), bound_at, bound_by (users.id). Only ever set on a service_type=''insurance_quote'' row (CHECK tvs_policy_shape). NULL means no policy on file — an honest state the UI states plainly. NO parallel table: the policy is the outcome of the insurance engagement, so it lives on it.';

-- The policy belongs to the INSURANCE engagement and nothing else. Enforced,
-- not merely intended: without this an inspector row could carry a policy and
-- the pre-closing detector would count it as the buyer's coverage.
ALTER TABLE transaction_vendor_services DROP CONSTRAINT IF EXISTS tvs_policy_shape;
ALTER TABLE transaction_vendor_services ADD CONSTRAINT tvs_policy_shape
  CHECK (policy IS NULL
         OR (service_type = 'insurance_quote' AND hazard_policy_record_ok(policy)));

-- ── 3. THE MARKETPLACE LINK ────────────────────────────────────────────────
-- vendor_name is free text. When the carrier came off the brokerage's own
-- marketplace, the deal must record WHICH vendor row — otherwise the referral
-- cannot be traced back to the spot it came from, the vendor's own certificate
-- of insurance (m376) cannot be checked, and a review cannot be attributed.
-- NULLABLE on purpose: a buyer who brings their own agent from outside the
-- marketplace is normal and must remain recordable. ON DELETE SET NULL — a
-- delisted vendor must never delete the deal's insurance record.
ALTER TABLE transaction_vendor_services
  ADD COLUMN IF NOT EXISTS vendor_id uuid;

ALTER TABLE transaction_vendor_services DROP CONSTRAINT IF EXISTS tvs_vendor_id_fkey;
ALTER TABLE transaction_vendor_services ADD CONSTRAINT tvs_vendor_id_fkey
  FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL;

COMMENT ON COLUMN transaction_vendor_services.vendor_id IS
  'vendors.id of the marketplace vendor this engagement came from, or NULL when the client brought their own provider from outside the marketplace. NOT agents.id / contacts.id. Resolved, never substituted.';

CREATE INDEX IF NOT EXISTS idx_tvs_vendor_id
  ON transaction_vendor_services (vendor_id)
  WHERE vendor_id IS NOT NULL;

-- ── 4. THE 'bound' STATUS ──────────────────────────────────────────────────
-- WIDEN, never narrow. 'approved' means the client accepted the quote;
-- 'bound' means coverage is actually in force and the binder is on file. A
-- lender will not fund on the former. Collapsing them into 'completed' would
-- erase the only distinction that stops a closing.
ALTER TABLE transaction_vendor_services DROP CONSTRAINT IF EXISTS transaction_vendor_services_status_check;
ALTER TABLE transaction_vendor_services ADD CONSTRAINT transaction_vendor_services_status_check
  CHECK (status = ANY (ARRAY[
    'ordered', 'scheduled', 'in_progress', 'completed', 'cancelled',
    'quote_requested', 'pending_approval', 'approved',
    'bound'                      -- m385
  ]::text[]));

-- ── 5. THE PRE-CLOSING DETECTOR'S ACTION TYPE ──────────────────────────────
-- lib/transactions/closing-orchestration.ts is the EXISTING closing-prerequisite
-- engine (clear_to_close_late at 10 days, cda_missing at 7, wire/walkthrough at
-- 5). The hazard-insurance lead-time reminder rides it rather than inventing a
-- second one, so it needs its action_type admitted. WIDEN, never narrow.
ALTER TABLE transaction_pending_actions DROP CONSTRAINT IF EXISTS transaction_pending_actions_action_type_check;
ALTER TABLE transaction_pending_actions ADD CONSTRAINT transaction_pending_actions_action_type_check
  CHECK (action_type = ANY (ARRAY[
    'appraisal_not_ordered', 'inspection_window_closing', 'inspection_overdue',
    'em_not_received', 'lender_condition_stale', 'clear_to_close_late',
    'walkthrough_unscheduled', 'wire_instructions_missing', 'cda_missing',
    'title_commitment_late', 'financing_deadline_close', 'contract_followup_check',
    'hazard_insurance_unbound'   -- m385
  ]::text[]));

-- ── 6. LOUD VERIFICATION — RAISE if the migration did not achieve its goal ──
DO $mig$
DECLARE
  n  integer;
  tx uuid;
BEGIN
  -- 6a. The check function exists and is IMMUTABLE (a VOLATILE function cannot
  --     back a CHECK, so this is the load-bearing property).
  SELECT count(*) INTO n
    FROM pg_proc
   WHERE proname = 'hazard_policy_record_ok'
     AND provolatile = 'i';
  IF n <> 1 THEN
    RAISE EXCEPTION 'm385 FAILED: hazard_policy_record_ok is missing or not IMMUTABLE (found %)', n;
  END IF;

  -- 6b. Both classification CHECKs admit the binder, and still admit every
  --     member they admitted before (widened, not replaced).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.documents'::regclass
       AND conname  = 'documents_classification_check'
       AND pg_get_constraintdef(oid) LIKE '%insurance_binder%'
       AND pg_get_constraintdef(oid) LIKE '%listing_agreement%'
       AND pg_get_constraintdef(oid) LIKE '%preliminary_closing_statement%'
  ) THEN
    RAISE EXCEPTION 'm385 FAILED: documents.classification does not admit insurance_binder alongside the pre-existing vocabulary';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.brokerage_required_documents'::regclass
       AND conname  = 'brd_classification_check'
       AND pg_get_constraintdef(oid) LIKE '%insurance_binder%'
       AND pg_get_constraintdef(oid) LIKE '%seller_broker_agreement%'
  ) THEN
    RAISE EXCEPTION 'm385 FAILED: brokerage_required_documents.classification does not admit insurance_binder — a brokerage could not require the binder';
  END IF;

  -- 6c. The vendor link is a real FK into vendors, not a loose uuid.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid  = 'public.transaction_vendor_services'::regclass
       AND conname   = 'tvs_vendor_id_fkey'
       AND contype   = 'f'
       AND confrelid = 'public.vendors'::regclass
  ) THEN
    RAISE EXCEPTION 'm385 FAILED: transaction_vendor_services.vendor_id is not FK-bound to vendors(id)';
  END IF;

  -- 6d. 'bound' and 'hazard_insurance_unbound' are admitted.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.transaction_vendor_services'::regclass
       AND conname  = 'transaction_vendor_services_status_check'
       AND pg_get_constraintdef(oid) LIKE '%bound%'
       AND pg_get_constraintdef(oid) LIKE '%pending_approval%'
  ) THEN
    RAISE EXCEPTION 'm385 FAILED: transaction_vendor_services.status does not admit ''bound'' alongside the pre-existing vocabulary';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.transaction_pending_actions'::regclass
       AND conname  = 'transaction_pending_actions_action_type_check'
       AND pg_get_constraintdef(oid) LIKE '%hazard_insurance_unbound%'
       AND pg_get_constraintdef(oid) LIKE '%cda_missing%'
  ) THEN
    RAISE EXCEPTION 'm385 FAILED: transaction_pending_actions.action_type does not admit hazard_insurance_unbound alongside the pre-existing detectors';
  END IF;

  -- 6e. BEHAVIOURAL PROOF, not presence. A complete policy is ACCEPTED …
  IF NOT hazard_policy_record_ok(
    '{"carrier":"Acme Mutual","policy_number":"HO-1","coverage_amount":450000,
      "annual_premium":1840,"effective_date":"2026-09-01","expiry":"2027-09-01",
      "document_id":"00000000-0000-0000-0000-000000000000",
      "bound_at":"2026-08-07T00:00:00.000Z",
      "bound_by":"00000000-0000-0000-0000-000000000000"}'::jsonb) THEN
    RAISE EXCEPTION 'm385 FAILED: a complete, valid bound policy was REJECTED';
  END IF;

  -- … and every hazard it exists to stop is REFUSED.
  IF hazard_policy_record_ok('{"expires":"2027-09-01"}'::jsonb) THEN
    RAISE EXCEPTION 'm385 FAILED: a typo''d field name was accepted — the expiry would be invisible to the pre-closing detector';
  END IF;
  IF hazard_policy_record_ok('{"expiry":"09/01/2027"}'::jsonb) THEN
    RAISE EXCEPTION 'm385 FAILED: an unparseable expiry was accepted — a lapsed policy would read as coverage in force';
  END IF;
  IF hazard_policy_record_ok('{"coverage_amount":-1}'::jsonb) THEN
    RAISE EXCEPTION 'm385 FAILED: a negative coverage amount was accepted';
  END IF;
  IF hazard_policy_record_ok('{"coverage_amount":"450000"}'::jsonb) THEN
    RAISE EXCEPTION 'm385 FAILED: a stringly-typed coverage amount was accepted';
  END IF;
  IF hazard_policy_record_ok('{"annual_premium":-1}'::jsonb) THEN
    RAISE EXCEPTION 'm385 FAILED: a negative premium was accepted';
  END IF;

  -- The honest states MUST stay representable. "No policy on file" is the whole
  -- point of the feature; a partially-known policy (carrier known, premium not)
  -- is the normal state between binding and the declarations page arriving.
  IF NOT hazard_policy_record_ok(NULL) THEN
    RAISE EXCEPTION 'm385 FAILED: "no policy on file" is no longer representable';
  END IF;
  IF NOT hazard_policy_record_ok('{"carrier":"Acme Mutual","expiry":"2027-09-01"}'::jsonb) THEN
    RAISE EXCEPTION 'm385 FAILED: a partially-known policy is no longer representable';
  END IF;

  -- 6f. And prove the CONSTRAINTS bite on a real row, including the rule that a
  --     non-insurance service may never carry a policy. Rolled back — no test
  --     data survives.
  SELECT id INTO tx FROM transactions LIMIT 1;
  IF tx IS NOT NULL THEN
    BEGIN
      INSERT INTO transaction_vendor_services (transaction_id, service_type, vendor_name, status, policy)
      VALUES (tx, 'inspection', 'm385 probe', 'ordered',
              '{"carrier":"Acme Mutual","expiry":"2027-09-01"}'::jsonb);
      RAISE EXCEPTION 'm385 FAILED: a non-insurance service row accepted a hazard policy';
    EXCEPTION WHEN check_violation THEN
      NULL;  -- 23514 — exactly what we wanted.
    END;

    BEGIN
      INSERT INTO transaction_vendor_services (transaction_id, service_type, vendor_name, status, policy)
      VALUES (tx, 'insurance_quote', 'm385 probe', 'bound',
              '{"expiry":"12/31/2027"}'::jsonb);
      RAISE EXCEPTION 'm385 FAILED: the table accepted an unparseable policy expiry on a live row';
    EXCEPTION WHEN check_violation THEN
      NULL;
    END;
  END IF;

  RAISE NOTICE 'm385 OK — insurance_binder in both classification vocabularies, policy shape pinned to the insurance engagement, vendor_id FK-bound to vendors(id), bound + hazard_insurance_unbound admitted.';
END $mig$;

COMMIT;
