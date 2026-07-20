-- 1104: closing_cost_accuracy_observations — the CLOSING-COST ACCURACY FLYWHEEL
-- (owner round 34, rec 5). When a transaction CLOSES with a scanned Closing
-- Disclosure on the document kernel rail (documents.classification =
-- 'closing_disclosure' + provenance-checked rows in document_field_extractions),
-- lib/offers/closing-cost-accuracy.ts records ONE observation: the deal's state,
-- the deterministic regional estimate bands, and the CD's ACTUAL borrower-paid
-- figures for the lines that map cleanly (owner's title, settlement fee,
-- recording+transfer, lender's title). The per-state rollup on the superadmin
-- platform page ARMS the yearly finance review of the convention table
-- (lib/offers/regional-closing-costs.ts) — conventions stay code; NOTHING here
-- auto-adjusts them.
--
-- ⚠ REPORT-ONLY until the owner applies it (round-34 directive: write the SQL,
-- do NOT apply). Until applied, the writer and reader degrade honestly
-- (recorder returns {recorded:false, reason}; report shows available:false).
-- AFTER APPLYING: regenerate scripts/schema-snapshot.ts so the schema-drift
-- guard column-checks this table (see snapshot header for the workflow).
--
-- Decoupled FKs (brokerage only) to stay drop-safe, same as m1101
-- net_sheet_reconciliations. Tenant-scoped. One row per (transaction, CD doc).

CREATE TABLE IF NOT EXISTS closing_cost_accuracy_observations (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id          uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  transaction_id        uuid        NOT NULL,
  document_id           uuid        NOT NULL,
  -- USPS state code the regional estimate was derived from
  state                 text        NOT NULL,
  purchase_price        numeric     NOT NULL,
  -- the loan used to recompute the estimate (CD-extracted, else the tx record; null = unknown/cash-path pending)
  loan_amount           numeric,
  -- true when at least one ledger row used was human-verified (verified_at set)
  extraction_verified   boolean     NOT NULL DEFAULT false,
  -- which CD field_keys were provenance-usable on this observation
  extracted_field_keys  text[]      NOT NULL DEFAULT '{}',
  -- the graded lines: [{key,label,estimateLow,estimateHigh,actual,deltaFromMid,withinBand}]
  lines                 jsonb       NOT NULL,
  line_count            integer     NOT NULL,
  -- context-only figures (NEVER compared to the estimate total: cash_to_close
  -- includes the down payment; section-J total nets lender credits)
  cash_to_close         numeric,
  total_closing_costs   numeric,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_ccao_state     ON closing_cost_accuracy_observations(state, created_at);
CREATE INDEX IF NOT EXISTS idx_ccao_brokerage ON closing_cost_accuracy_observations(brokerage_id, created_at);

ALTER TABLE closing_cost_accuracy_observations ENABLE ROW LEVEL SECURITY;
-- Writes and the cross-tenant superadmin report go through the service client;
-- no user-role policies on purpose (matches net_sheet_reconciliations).
CREATE POLICY closing_cost_accuracy_observations_service
  ON closing_cost_accuracy_observations FOR ALL TO service_role
  USING (true) WITH CHECK (true);
