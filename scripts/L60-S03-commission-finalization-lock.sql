-- scripts/L60-S03-commission-finalization-lock.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- COMMISSION FINALIZATION LOCK (owner rule: "the transaction commission isn't final
-- until the final CDA is signed by a broker or final CD uploaded to the transaction").
-- A transaction's commission is an ESTIMATE until one of those two events fires; from
-- then it is immutable. These columns record WHEN and by WHICH event a transaction's
-- commission was locked; the waterfall engine refuses to re-persist a finalized
-- transaction's commission (which also stops the duplicate-commissions-row bug).
--   • commission_finalized_at  — set once, first-writer-wins (CDA sign or CD upload)
--   • commission_final_source  — 'cda_signed' | 'cd_uploaded'

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS commission_finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS commission_final_source text
    CHECK (commission_final_source IS NULL OR commission_final_source IN ('cda_signed','cd_uploaded'));
