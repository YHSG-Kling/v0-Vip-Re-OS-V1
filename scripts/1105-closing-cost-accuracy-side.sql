-- 1105: closing_cost_accuracy_observations — the SELLER SIDE discriminator
-- (owner round 36: "closing costs is for seller side and another closing costs
-- for buyer side"). The round-34 flywheel graded the BUYER estimate against the
-- CD's borrower-paid column; lib/offers/closing-cost-accuracy.ts now also
-- grades the SELLER estimate (lib/offers/seller-closing-costs) against the
-- settlement statement on closed SALE-side deals. Both sides share ONE ledger,
-- discriminated by `side`, so the prediction-accuracy rail keeps a single
-- closing_costs read with an additive buyer/seller breakdown.
--
-- ⚠ REPORT-ONLY until the owner applies it (same directive as m1104: write the
-- SQL, do NOT apply). Until applied:
--   · the buyer writer falls back to the legacy 2-column upsert (rows are
--     buyer-side by construction),
--   · the seller writer degrades honestly ({recorded:false, reason names 1105}),
--   · the analytics adapter retries its select without `side`.
-- AFTER APPLYING: regenerate scripts/schema-snapshot.ts (same workflow as m1104).
--
-- Idempotent. Depends on m1104 (the table itself).

-- 1) The side discriminator; every pre-existing row was buyer-side.
ALTER TABLE closing_cost_accuracy_observations
  ADD COLUMN IF NOT EXISTS side text NOT NULL DEFAULT 'buyer';

DO $$
BEGIN
  ALTER TABLE closing_cost_accuracy_observations
    ADD CONSTRAINT ccao_side_check CHECK (side IN ('buyer', 'seller'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2) One observation per (transaction, document, SIDE): a CD can honestly
-- grade BOTH sides of the same deal. Drop the m1104 2-column unique (found by
-- shape — Postgres may have truncated the auto-generated name) and replace it
-- with the 3-column key the writers upsert against.
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c
    FROM pg_constraint
   WHERE conrelid = 'closing_cost_accuracy_observations'::regclass
     AND contype = 'u'
     AND array_length(conkey, 1) = 2;
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE closing_cost_accuracy_observations DROP CONSTRAINT %I', c);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ccao_txn_doc_side_key
  ON closing_cost_accuracy_observations (transaction_id, document_id, side);

-- 3) Side-aware read path for the per-side rollups.
CREATE INDEX IF NOT EXISTS idx_ccao_side ON closing_cost_accuracy_observations (side, created_at);
