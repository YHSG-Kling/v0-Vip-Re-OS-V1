-- WRITTEN, NOT APPLIED (wave 143, lane 143A) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN are owner SQL-editor
--
-- m797 — CONTRACT TERM VERSIONS: THE VERSIONED, IMMUTABLE RECORD OF WHAT THE CONTRACT SAYS (wave 143, lane 143A).
--
-- Owner (wave 143): "CLOSING compliance also checks that commission and contract terms match the settlement (which party pays
-- the title owner's policy, etc.); a counter supersedes the contract terms."
-- Brief: a versioned authoritative terms record; an executed counter/addendum supersedes inconsistent earlier terms; originals
-- preserved; ONE reader (lib/offers/governing-terms.ts governingContractTerms).
--
-- AUDIT FIRST (CLAUDE.md §1): the versioned CHAIN already exists and is untouched — every counter is a new `offers` row
-- (parent_offer_id, current_round, the carried CONTRACT_TERM_COLUMNS) and an original is never mutated. What did NOT exist:
--   (a) an immutable record of the terms AT EXECUTION (offers rows are editable by agents; a dispute needs what was signed),
--   (b) any structured home for ADDENDA and AMENDMENTS (documents hold the PDF, not the terms),
--   (c) a home for terms that are not offers columns at all — WHO PAYS THE OWNER'S TITLE POLICY has no column anywhere.
-- Two other tables were checked and do not serve: `transaction_repair_negotiations` (repair requests, not contract terms) and
-- `tenant_policy_versions` (tenant operating policy). Neither is a second spelling of this record.
--
-- THE PRECEDENCE RULE lives in code, not here (lib/offers/governing-terms.ts resolveGoverningTerms): the latest EXECUTED version
-- that names a term governs it; a `proposed` version never governs; nothing is deleted or updated to "superseded" — precedence is
-- computed at read time, so the originals are preserved by construction. A recorded version of source offer|counter is written
-- either (1) as a PROPOSED row carrying a person-confirmed term set (a received counter, a buyer counter-back), whose execution
-- state then follows the offers row, or (2) as an EXECUTED snapshot at offer→transaction promotion (immutable).
--
-- Tenant isolation: brokerage_id NOT NULL, RLS tenant-read, service-role writes (the unique index below makes a concurrent
-- duplicate a refusal, never a second row).
--
-- Applicable in two small parts (wave 98 rule). Idempotent.

-- ── PART 1 — table ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contract_term_versions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  -- The chain's ORIGINAL offer. NULL only for a manual transaction with no offer chain.
  root_offer_id   uuid        NULL REFERENCES public.offers(id) ON DELETE SET NULL,
  -- The offers row this version came from (the original offer or the counter row); NULL for an addendum / amendment.
  offer_id        uuid        NULL REFERENCES public.offers(id) ON DELETE SET NULL,
  transaction_id  uuid        NULL REFERENCES public.transactions(id) ON DELETE SET NULL,
  -- The document the terms came from (the executed counter / addendum). Required for an EXECUTED addendum/amendment (code-enforced).
  document_id     uuid        NULL REFERENCES public.documents(id) ON DELETE SET NULL,
  version_no      integer     NOT NULL CHECK (version_no >= 1),
  source          text        NOT NULL
    CONSTRAINT contract_term_versions_source_check CHECK (source IN ('offer', 'counter', 'addendum', 'amendment')),
  status          text        NOT NULL DEFAULT 'proposed'
    CONSTRAINT contract_term_versions_status_check CHECK (status IN ('proposed', 'executed', 'void')),
  -- Canonical term keys only (lib/offers/governing-terms.ts GOVERNING_TERM_KEYS — enforced by the writer). An explicit JSON null is a deliberate STRIKE.
  terms           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  executed_at     timestamptz NULL,
  recorded_by     uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  evidence        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_term_versions_anchor_check CHECK (root_offer_id IS NOT NULL OR transaction_id IS NOT NULL),
  CONSTRAINT contract_term_versions_executed_has_instant_check CHECK (status <> 'executed' OR executed_at IS NOT NULL),
  CONSTRAINT contract_term_versions_terms_object_check CHECK (jsonb_typeof(terms) = 'object')
);

COMMENT ON TABLE public.contract_term_versions IS
  'm797 (wave 143A): the versioned, immutable record of contract terms. Precedence is computed at read time (lib/offers/governing-terms.ts): the latest EXECUTED version naming a term governs it; proposed never governs; originals are never mutated. ONE reader: governingContractTerms(transactionId|offerId).';

-- ── PART 2 — indexes + RLS ─────────────────────────────────────────────────────────────────────────
-- One version number per chain (or per transaction when there is no chain) PER SOURCE: an offers-row version carries the row's own
-- number (root = 1, a counter = its round) and an addendum / amendment is numbered within its own source, so the two sequences cannot
-- collide. A concurrent duplicate is a refusal.
CREATE UNIQUE INDEX IF NOT EXISTS contract_term_versions_chain_version_uidx
  ON public.contract_term_versions (brokerage_id, COALESCE(root_offer_id, transaction_id), source, version_no);
CREATE INDEX IF NOT EXISTS contract_term_versions_root_idx ON public.contract_term_versions (brokerage_id, root_offer_id) WHERE root_offer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contract_term_versions_txn_idx ON public.contract_term_versions (brokerage_id, transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contract_term_versions_offer_idx ON public.contract_term_versions (offer_id) WHERE offer_id IS NOT NULL;

ALTER TABLE public.contract_term_versions ENABLE ROW LEVEL SECURITY;

-- Tenant staff read their brokerage's terms (closing compliance, the transaction file). Writes come only through the service role.
CREATE POLICY contract_term_versions_tenant_read ON public.contract_term_versions
  FOR SELECT TO authenticated
  USING (brokerage_id = public.current_user_brokerage_id());

REVOKE INSERT, UPDATE, DELETE ON public.contract_term_versions FROM authenticated, anon;
GRANT SELECT ON public.contract_term_versions TO authenticated;

-- After applying: regenerate scripts/schema-snapshot.ts, scripts/live-tables.ts, scripts/schema-fk-map.ts and
-- scripts/check-vocabularies.ts from the live JSON (CLAUDE.md §3) — two new CHECK vocabularies (source, status).
