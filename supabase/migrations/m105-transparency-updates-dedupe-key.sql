-- m105 — DB-level idempotency for transparency_updates fan-out writer.
--
-- WHY: Audit caught that lib/kernel/event-fanout.ts dedupes via SELECT-then-INSERT
-- (PORTAL_DEDUPE_WINDOW_MS) — racy under concurrent emits. Two parallel fan-outs of the same
-- KernelEvent can both miss the SELECT and both INSERT, producing duplicate client portal cards.
--
-- FIX: Add a `dedupe_key TEXT` column and a partial UNIQUE index on (contact_id, dedupe_key) WHERE
-- dedupe_key IS NOT NULL. The fan-out writer computes a dedupe_key from
-- (update_type, title, 10-minute time bucket) and inserts with ON CONFLICT DO NOTHING — Postgres
-- enforces the invariant under concurrency.
--
-- Non-fan-out writers (vendor-quote-workflow, transaction-transparency action handlers, net-sheet
-- calculator, lib/application/transactions) intentionally bypass this column (NULL dedupe_key) —
-- they're writing workflow-specific cards that aren't natural dedupe candidates; their idempotency
-- comes from the upstream workflow step (one milestone → one card by construction).

ALTER TABLE transparency_updates
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

-- Partial unique index — only rows where dedupe_key IS NOT NULL participate. This lets non-fan-out
-- writers keep inserting without breaking the constraint, while the fan-out path is hard-protected.
CREATE UNIQUE INDEX IF NOT EXISTS transparency_updates_contact_dedupe_key_uniq
  ON transparency_updates(contact_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- Index for the existing dedupe-window query path (covers the legacy SELECT until all writers
-- migrate to the new dedupe_key approach — keeps the fallback fast).
CREATE INDEX IF NOT EXISTS transparency_updates_contact_event_created_idx
  ON transparency_updates(contact_id, update_type, created_at DESC);

COMMENT ON COLUMN transparency_updates.dedupe_key IS
  'Set by lib/kernel/event-fanout writePortalUpdate(); format: ${update_type}:${title_hash}:${10min_bucket}. NULL for non-fan-out writers (workflow-specific cards).';
