-- ── APPLIED LIVE 2026-11-14 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 153, lane 153C ── read back: 31 columns, 21 checks, 4 FKs + idempotency unique, RLS + staff select policy
--
-- THE CLOSING DISCLOSURE RECEIPT LEDGER — the evidence the TRID waiting period starts from (wave 153, lane 153C; directive §153C
-- C2; owner ruling 6, verbatim 2026-11-14: "trid is determined from the lender because the lender sends the final cd to the buyer
-- to sign and should mark when trid starts and if lender isn't on the platform, the agent needs to find out from the lender and
-- then mark the timeline (a good coaching moment)").
--
-- CENSUS (live, read-only, 2026-11-14) — why a new table and not a column:
--   · trid_timeline        ONE row per deal (UNIQUE transaction_id), four DATE columns + compliance_status + violations. No issuer,
--                          no sender, no version, no method, no receipt evidence, no source, no confirmation — a typed date is all
--                          it can hold, which is exactly the "agent guess" the owner ruled out. It stays the per-deal SUMMARY:
--                          closing_disclosure_delivered_date now carries the lender-verified EFFECTIVE RECEIPT date, written only
--                          by lib/compliance/trid-disclosure-clock-evidence.ts. 0 live rows.
--   · transaction_documents  the DOCUMENT rail (a draft upload lives here) — status is the document lifecycle, and an off-platform
--                          lender's CD may never be uploaded at all; receipt is an event about delivery, not a document state.
--   · policy_decisions     a decision ledger (green / amber / red); a receipt is evidence, not a decision.
--   · agent_action_ledger  records that an action ran (withActionLedger) — not the state a reader computes from.
--   Nothing holds versioned delivery / receipt evidence, so the ledger is new; it is INSERT-ONLY (a correction or a lender's
--   confirmation is a NEW row naming the row it supersedes — history is never overwritten).
--
-- ONE VOCABULARY PER CHECK, ONE CODE CONSTANT AS ITS SOURCE (lib/compliance/trid-disclosure-clock.ts):
--   delivery_method                TRID_DELIVERY_METHODS
--   receipt_evidence               TRID_RECEIPT_EVIDENCE        (a signature is NOT a value — it is stored in acknowledgment_signed_at)
--   source                         TRID_RECEIPT_SOURCES
--   verification_status            TRID_VERIFICATION_STATUSES   (only lender_confirmed can start the waiting period)
--   sender_role                    TRID_SENDER_ROLES
--   transaction_regularity         TRID_TRANSACTION_REGULARITY  (the lender's classification for the 1026.22 APR tolerance)
--   lender_new_wait_determination  TRID_NEW_WAIT_DETERMINATIONS
--   revision_changes (text[])      TRID_REVISION_CHANGES
--
-- ROLLBACK: DROP TABLE public.trid_disclosure_receipts; (owner SQL — a DROP is owner-held). No other object depends on it; the
-- readers degrade to "no receipt on file" (the close stays held), never to a TRID-ready.

BEGIN;

CREATE TABLE IF NOT EXISTS public.trid_disclosure_receipts (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id                    uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE RESTRICT,
  transaction_id                  uuid NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
  -- 1 = the initial Closing Disclosure; each revised CD is the next version
  disclosure_version              integer NOT NULL CHECK (disclosure_version >= 1 AND disclosure_version <= 50),
  supersedes_id                   uuid REFERENCES public.trid_disclosure_receipts(id) ON DELETE RESTRICT,
  issuer_name                     text NOT NULL CHECK (char_length(issuer_name) BETWEEN 1 AND 200),
  sender_role                     text NOT NULL,
  sender_name                     text CHECK (char_length(sender_name) <= 200),
  delivery_method                 text NOT NULL,
  delivered_at                    timestamptz,
  received_at                     timestamptz,
  -- the consumer's IANA zone: the receipt's calendar day is the consumer's local day
  receipt_timezone                text NOT NULL CHECK (char_length(receipt_timezone) BETWEEN 3 AND 64),
  receipt_evidence                text NOT NULL,
  acknowledgment_signed_at        timestamptz,
  -- transaction_documents.id of the CD (or of the lender's written confirmation on a compliance-verified row); minted by the door
  document_id                     uuid,
  source                          text NOT NULL,
  reported_by                     uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  -- an agent-reported row names who at the lender said it, and how (phone / email / portal) — never a free-floating claim
  lender_contact_name             text CHECK (char_length(lender_contact_name) <= 200),
  lender_contact_method           text CHECK (char_length(lender_contact_method) <= 200),
  verification_status             text NOT NULL,
  revision_changes                text[] NOT NULL DEFAULT '{}',
  apr_previous                    numeric CHECK (apr_previous >= 0 AND apr_previous < 100),
  apr_current                     numeric CHECK (apr_current >= 0 AND apr_current < 100),
  transaction_regularity          text,
  lender_new_wait_determination   text,
  -- computed by the writer from the evidence (the reader recomputes; these are the record of what was decided at write time)
  effective_receipt_date          date,
  earliest_consummation_date      date,
  receipt_basis                   text CHECK (receipt_basis IN ('actual_receipt', 'in_person', 'deemed_mailbox_rule', 'none')),
  notes                           text CHECK (char_length(notes) <= 2000),
  idempotency_key                 text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trid_disclosure_receipts_idempotency_key UNIQUE (transaction_id, idempotency_key)
);

ALTER TABLE public.trid_disclosure_receipts DROP CONSTRAINT IF EXISTS trid_disclosure_receipts_sender_role_check;
ALTER TABLE public.trid_disclosure_receipts ADD CONSTRAINT trid_disclosure_receipts_sender_role_check
  CHECK (sender_role IN ('creditor', 'settlement_agent'));
ALTER TABLE public.trid_disclosure_receipts DROP CONSTRAINT IF EXISTS trid_disclosure_receipts_delivery_method_check;
ALTER TABLE public.trid_disclosure_receipts ADD CONSTRAINT trid_disclosure_receipts_delivery_method_check
  CHECK (delivery_method IN ('in_person', 'mail', 'email', 'electronic_portal', 'courier', 'fax', 'other'));
ALTER TABLE public.trid_disclosure_receipts DROP CONSTRAINT IF EXISTS trid_disclosure_receipts_receipt_evidence_check;
ALTER TABLE public.trid_disclosure_receipts ADD CONSTRAINT trid_disclosure_receipts_receipt_evidence_check
  CHECK (receipt_evidence IN ('in_person_delivery', 'consumer_acknowledged_receipt', 'lender_esign_receipt', 'lender_statement', 'mailbox_rule'));
ALTER TABLE public.trid_disclosure_receipts DROP CONSTRAINT IF EXISTS trid_disclosure_receipts_source_check;
ALTER TABLE public.trid_disclosure_receipts ADD CONSTRAINT trid_disclosure_receipts_source_check
  CHECK (source IN ('lender_portal', 'agent_reported', 'tc_reported', 'compliance_verified'));
ALTER TABLE public.trid_disclosure_receipts DROP CONSTRAINT IF EXISTS trid_disclosure_receipts_verification_status_check;
ALTER TABLE public.trid_disclosure_receipts ADD CONSTRAINT trid_disclosure_receipts_verification_status_check
  CHECK (verification_status IN ('lender_confirmed', 'pending_lender_confirmation', 'rejected'));
ALTER TABLE public.trid_disclosure_receipts DROP CONSTRAINT IF EXISTS trid_disclosure_receipts_transaction_regularity_check;
ALTER TABLE public.trid_disclosure_receipts ADD CONSTRAINT trid_disclosure_receipts_transaction_regularity_check
  CHECK (transaction_regularity IN ('regular', 'irregular'));
ALTER TABLE public.trid_disclosure_receipts DROP CONSTRAINT IF EXISTS trid_disclosure_receipts_lender_new_wait_determination_check;
ALTER TABLE public.trid_disclosure_receipts ADD CONSTRAINT trid_disclosure_receipts_lender_new_wait_determination_check
  CHECK (lender_new_wait_determination IN ('new_wait_required', 'no_new_wait'));
ALTER TABLE public.trid_disclosure_receipts DROP CONSTRAINT IF EXISTS trid_disclosure_receipts_revision_changes_check;
ALTER TABLE public.trid_disclosure_receipts ADD CONSTRAINT trid_disclosure_receipts_revision_changes_check
  CHECK (revision_changes <@ ARRAY['apr_changed', 'loan_product_changed', 'prepayment_penalty_added', 'other_terms']::text[]);
-- A STATEMENT IS NOT A CONFIRMATION: an agent / TC report can never be stored as lender-confirmed.
ALTER TABLE public.trid_disclosure_receipts DROP CONSTRAINT IF EXISTS trid_disclosure_receipts_report_is_pending;
ALTER TABLE public.trid_disclosure_receipts ADD CONSTRAINT trid_disclosure_receipts_report_is_pending
  CHECK (source NOT IN ('agent_reported', 'tc_reported') OR verification_status <> 'lender_confirmed');
-- Something has to anchor the clock: a receipt instant or a delivery instant.
ALTER TABLE public.trid_disclosure_receipts DROP CONSTRAINT IF EXISTS trid_disclosure_receipts_has_an_instant;
ALTER TABLE public.trid_disclosure_receipts ADD CONSTRAINT trid_disclosure_receipts_has_an_instant
  CHECK (received_at IS NOT NULL OR delivered_at IS NOT NULL);

COMMENT ON TABLE public.trid_disclosure_receipts IS 'wave 153 (153C): insert-only Closing Disclosure delivery / receipt evidence per version. Only lender_confirmed rows start the TRID waiting period; agent / TC reports stay pending_lender_confirmation. Writer: lib/compliance/trid-disclosure-clock-evidence.ts recordTridReceiptEvidence.';

CREATE INDEX IF NOT EXISTS idx_trid_disclosure_receipts_deal
  ON public.trid_disclosure_receipts (brokerage_id, transaction_id, disclosure_version, created_at);

ALTER TABLE public.trid_disclosure_receipts ENABLE ROW LEVEL SECURITY;
-- Tenant staff read their own tenant's ledger; every write goes through the governed doors on the service role (no INSERT /
-- UPDATE / DELETE policy — the table is insert-only through one writer, and a session client cannot write it at all).
DROP POLICY IF EXISTS trid_disclosure_receipts_tenant_staff_select ON public.trid_disclosure_receipts;
CREATE POLICY trid_disclosure_receipts_tenant_staff_select ON public.trid_disclosure_receipts
  FOR SELECT TO authenticated USING (public.has_brokerage_access(brokerage_id) AND public.is_tenant_staff_seat());

COMMIT;

-- After apply (integrator):
--   1. regenerate scripts/schema-snapshot.ts, scripts/check-vocabularies.ts, scripts/live-tables.ts, scripts/schema-fk-map.ts;
--   2. add the CHECK mirrors to scripts/check-vocabulary-guard.ts (file lib/compliance/trid-disclosure-clock.ts, the eight constants above);
--   3. add `trid_disclosure_receipts: "deal_coordinator"` to the table-manager map in lib/kernel/manager-registry.ts.
-- Read-back:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.trid_disclosure_receipts'::regclass ORDER BY 1;
--   SELECT polname, polcmd FROM pg_policy WHERE polrelid = 'public.trid_disclosure_receipts'::regclass;
