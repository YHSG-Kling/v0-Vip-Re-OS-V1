-- m370 · compliance_checklists: drop the redundant duplicate UNIQUE constraint
--
-- THE FINDING
-- ───────────
-- public.compliance_checklists carried TWO unique constraints that are byte-for-byte
-- the same guarantee on the same columns in the same order:
--
--   compliance_checklists_transaction_id_checklist_type_key  UNIQUE (transaction_id, checklist_type)
--   compliance_checklists_txn_type_unique                    UNIQUE (transaction_id, checklist_type)
--
-- Each unique constraint owns a real btree index, so the table was maintaining two
-- identical indexes: double the write cost, double the bloat, zero extra safety.
--
-- Worse, it is a trap for the next reader. The duplication is what made the previous
-- writer's comment ("point-in-time — no unique constraint on txn+type") so hard to
-- disprove at a glance, and a reader who finds one constraint and drops it still has
-- a table that raises duplicate-key from the other.
--
-- WHICH ONE SURVIVES, AND WHY
-- ───────────────────────────
-- KEPT:    compliance_checklists_transaction_id_checklist_type_key
-- DROPPED: compliance_checklists_txn_type_unique
--
-- Three reasons the `_key` one is the survivor:
--
--   1. IT IS THE ORIGINAL. Its pg_constraint oid (58107) sits in the same block as
--      the table's own primary key (cc_pkey, 58105) and foreign key (cc_transaction_id_fkey,
--      58108); the duplicate's oid is 106464, tens of thousands of objects later. The
--      surviving constraint was born with the table; the dropped one was bolted on
--      afterwards by a migration that did not check whether the guarantee already existed.
--
--   2. IT IS THE NAME POSTGRES REGENERATES. `<table>_<col>_<col>_key` is exactly the
--      identifier Postgres derives for an inline `UNIQUE (transaction_id, checklist_type)`
--      in a CREATE TABLE. Keeping it means a database rebuilt from the schema baseline
--      converges on the same constraint name as this live database. Keeping the
--      hand-written name instead would have guaranteed permanent drift between the two.
--
--   3. NOTHING DEPENDS ON THE DROPPED NAME. Verified before dropping: no foreign key
--      anywhere references compliance_checklists (pg_constraint.confrelid returns zero
--      rows), so neither unique constraint is a FK target, and no application code
--      names either constraint in an onConflict clause or in error handling — the three
--      writers all arbitrate by COLUMN LIST ("transaction_id,checklist_type"), which
--      Postgres resolves against whichever unique index covers those columns.
--
-- WHAT THIS MIGRATION MUST NOT DO
-- ───────────────────────────────
-- It must not drop BOTH. The three writers of this table
-- (ai-transaction-documents.ts : checkTransactionDisclosures,
--  ai-document-intelligence.ts : aiCheckDisclosures,
--  workflows.ts : triggerComplianceChecklist)
-- were all converted to .upsert(..., { onConflict: "transaction_id,checklist_type" }).
-- An ON CONFLICT that names columns REQUIRES a unique index on exactly those columns —
-- with no surviving constraint every one of those upserts fails at runtime with
-- "there is no unique or exclusion constraint matching the ON CONFLICT specification".
-- The DO block below therefore refuses to leave the table with anything other than
-- exactly one such constraint.

BEGIN;

-- Drop exactly the later duplicate. IF EXISTS keeps this migration re-runnable.
ALTER TABLE public.compliance_checklists
  DROP CONSTRAINT IF EXISTS compliance_checklists_txn_type_unique;

-- GUARD: the upserts' arbiter must still exist, and there must be exactly one of it.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
  FROM pg_constraint
  WHERE conrelid = 'public.compliance_checklists'::regclass
    AND contype = 'u'
    AND pg_get_constraintdef(oid) = 'UNIQUE (transaction_id, checklist_type)';

  IF n <> 1 THEN
    RAISE EXCEPTION
      'compliance_checklists must have exactly ONE unique constraint on (transaction_id, checklist_type); found %. Zero breaks every upsert''s ON CONFLICT arbiter; more than one is the redundancy this migration exists to remove.', n;
  END IF;
END $$;

COMMIT;
