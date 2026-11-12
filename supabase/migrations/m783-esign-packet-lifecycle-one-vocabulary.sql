-- ── APPLIED LIVE 2026-10-19 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — both CHECKs replaced + comments, two calls ──
--
-- m783 — THE E-SIGN PACKET LIFECYCLE, ONE VOCABULARY ON BOTH SIGNED-PACKET RECORDS (wave 142, lane 142B).
-- Owner (2026-10-18, verbatim): "States: draft · sent · partially_signed · all_signed · compliance_pending
-- · correction_required · compliance_approved · fully_executed · declined/voided/expired. Provider
-- completion ≠ compliance approval."
--
-- AUDITED AT HEAD fec8b6a95 (scripts/check-vocabularies.ts): offers.esign_status and
-- listing_agreements.esign_status carry the SAME six-value CHECK — declined · fully_signed ·
-- partially_signed · pending · sent · voided. Nothing distinguished "the provider says all signed"
-- (fully_signed) from "compliance approved the executed contract": the compliance verdict lived only in
-- offers.metadata.compliance_gate / listings.metadata.compliance_gate and compliance_passed_at, so a
-- packet in compliance read, on its status column, exactly like one the provider had just completed —
-- and a redelivered "envelope completed" webhook could legally re-stamp it.
--
-- THE SURVIVOR'S SPELLING IS KEPT (CLAUDE.md §1, §6): the owner's `draft` is the live `pending`
-- (submit-for-signature stamps it for a packet staged for the agent's send) and the owner's `all_signed`
-- is the live `fully_signed` (27 reader files; lib/transactions/coordination-status.ts
-- LISTING_AGREEMENT_EXECUTED_STATUS). Adding those two words would mint second spellings; renaming the
-- live values is a data migration over every row plus every reader, listed under "would need a
-- migration" in the lane notes, not done blind. The FIVE states the column lacks are added:
--   compliance_pending · correction_required · compliance_approved · fully_executed · expired
-- The code tuple is lib/esign/packet-states.ts ESIGN_PACKET_STATES; the proof
-- scripts/listing-offer-lifecycle-guard.ts asserts this CHECK's set equals that tuple for BOTH tables.
--
-- CONSTRAINT NAMES: the default inline-CHECK names (<table>_<column>_check — the shape m665 widened for
-- offers_esign_provider_check). Pre-check live before applying, one statement per MCP call:
--   SELECT conrelid::regclass, conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname IN ('offers_esign_status_check', 'listing_agreements_esign_status_check');
-- If a name differs, substitute it in the DROP; the ADD below is the superset either way.
--
-- APPLY IN TWO PARTS, ONE STATEMENT PER CALL (wave-108 lesson): each ALTER TABLE below is one atomic
-- statement (DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT inside one ALTER passes the MCP). No index,
-- trigger or data change: existing rows already satisfy the superset.
--
-- After applying: regenerate scripts/check-vocabularies.ts (CLAUDE.md §3) so check-vocabulary-guard
-- holds code and database in agreement.

-- ── PART 1 · offers.esign_status ──────────────────────────────────────────────────────────────────
ALTER TABLE public.offers
  DROP CONSTRAINT IF EXISTS offers_esign_status_check,
  ADD CONSTRAINT offers_esign_status_check
    CHECK (esign_status IS NULL OR esign_status IN (
      'pending', 'sent', 'partially_signed', 'fully_signed',
      'compliance_pending', 'correction_required', 'compliance_approved', 'fully_executed',
      'declined', 'voided', 'expired'
    ));

-- ── PART 2 · listing_agreements.esign_status ──────────────────────────────────────────────────────
ALTER TABLE public.listing_agreements
  DROP CONSTRAINT IF EXISTS listing_agreements_esign_status_check,
  ADD CONSTRAINT listing_agreements_esign_status_check
    CHECK (esign_status IS NULL OR esign_status IN (
      'pending', 'sent', 'partially_signed', 'fully_signed',
      'compliance_pending', 'correction_required', 'compliance_approved', 'fully_executed',
      'declined', 'voided', 'expired'
    ));

COMMENT ON COLUMN public.offers.esign_status IS
  'E-sign PACKET lifecycle (m783, lib/esign/packet-states.ts): pending (staged) → sent → partially_signed → fully_signed (the PROVIDER says all signed) → compliance_pending → correction_required | compliance_approved → fully_executed (compliance-approved executed contract; the transaction is created only here) · declined/voided/expired (provider terminal). Provider completion is never compliance approval.';
COMMENT ON COLUMN public.listing_agreements.esign_status IS
  'E-sign PACKET lifecycle (m783, lib/esign/packet-states.ts): pending → sent → partially_signed → fully_signed (provider all-signed) → compliance_pending → correction_required | compliance_approved → fully_executed (the listing agreement is FULLY EXECUTED only after compliance approval) · declined/voided/expired.';
