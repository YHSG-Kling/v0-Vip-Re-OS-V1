-- m598 — property_interactions: a table with zero writers retires onto the behavior log
-- ─────────────────────────────────────────────────────────────────────────────
-- STATUS: WRITTEN, NOT APPLIED. Lanes write migrations; only the integrator
-- applies them (CLAUDE.md §3). The integrator's post-apply checklist is at the
-- bottom of this header and is part of the migration, not a suggestion.
--
-- WHAT. Drop public.property_interactions and its named dependents, after
-- proving the table is empty. Every surviving reader has already been
-- repointed onto the live twin, buyer_behavior_log (or onto the honest
-- source for the one signal the twin cannot carry — see repoint 4b below).
--
-- ── ZERO-WRITER EVIDENCE (verified 2026-09-01, this lane) ────────────────────
--   · NO INSERT ANYWHERE. A tree-wide grep over stripped source finds no
--     `.from("property_interactions").insert`, no `.upsert`, no `.rpc()` that
--     touches it, and no SQL INSERT outside its own creation file
--     (supabase/migrations/060-long-tail-batch.sql:58-91).
--   · ITS ONLY TRIGGER NEVER FIRES. property_interactions_set_brokerage_trg is
--     BEFORE INSERT (060:85-86) — a trigger that can only run when something
--     inserts, and nothing ever has. Not a writer; a dependent.
--   · NO MIGRATION BACKFILL writes rows into it (grep over supabase/migrations
--     and scripts/*.sql: only CREATE TABLE / INDEX / POLICY / TRIGGER).
--   · EXPECTATION: ZERO ROWS on hrvaqgvukzxfskkcrwbt. The guard DO-block below
--     RAISEs if any row exists — if it fires, the zero-writer census was wrong
--     (a writer this lane could not see: console insert, applied-but-uncommitted
--     backfill), and the drop must NOT proceed until the rows are explained.
--
-- ── THE SIX REPOINTS (all landed in this lane, same wave as this file) ───────
--   1. app/actions/copilot.ts:522 (generateDailyGameplan) — the
--      property_interactions(*) embed on the hot-leads read was consumed by
--      NOTHING (prompt + dashboard read only name/score/stage/id). Deleted.
--   2. app/actions/copilot.ts:727→:744-751 (analyzeContactPriority) — the
--      untyped any-interaction 7-day count feeding score+=20 now counts
--      buyer_behavior_log VIEW∪SAVE signals for the contact, tenant-anchored,
--      {error} read. Same window/threshold/points.
--   3. app/actions/assistant.ts:358→:388-402 (getContactSuggestions) — the
--      "viewed N properties in last 24 hours" suggestion (which had NEVER
--      fired) now counts buyer_behavior_log VIEW_SIGNALS only — the copy says
--      VIEWED, so the view family alone is the honest filter.
--   4. lib/services/lead-management.service.ts:136 embed, consumed at :448
--      (engagement) and :617 (intent):
--      a. views*5 cap 25 / saves*10 cap 20 → VIEW_SIGNALS / SAVE_SIGNALS
--         counts from buyer_behavior_log (the same split the exported sets in
--         lib/behavior-learning/signal-mapping.ts:179-181 were lifted for).
--      b. tour_request*10 cap 10 → showing_requests count for the contact.
--         The meaning does NOT survive a naïve repoint: buyer_behavior_log has
--         no tour-request value (its tour-adjacent spellings are post-tour
--         verdicts; signal-mapping.ts:29: "tour_requested — logistics, not
--         taste"). showing_requests is the real request record — written by
--         requestShowing (app/actions/showings.ts:150-176) with contact_id +
--         brokerage_id, including the portal concierge create_showing door
--         (lib/portal/client-action-dispatch.ts:49-64).
--   5. lib/services/contact-management.service.ts:372-381 (getContact) — the
--      nested property_interactions(...listings(...)) embed fed nothing.
--      Deleted with a tombstone; buyer_behavior_log carries the denormalized
--      property facts flat if a future card wants the graph.
--   6. lib/services/contact-management.service.ts:~727 (mergeContacts) — the
--      duplicate→primary re-key now targets buyer_behavior_log (the table that
--      actually carries the per-contact behavior trail), error READ, failure
--      aborts before the soft delete. The property_interactions line is gone.
--   (The seventh reader, app/actions/email-campaigns.ts:931-965, was already
--   repointed in wave 22 — the working precedent for the signal families and
--   the dual-key .or() with validated mls_number.)
--
-- ── THE ORDERING LAW, quoted from lib/kernel/listing-archive.ts:255-260 ──────
--   "ORDERING MATTERED AND IS WHY THIS ENTRY OUTLIVED THE TABLE BY ONE STEP:
--    this manifest checks itself against SCHEMA_FK_MAP, so the entry could only
--    be removed AFTER the drop and the cache regeneration, and the drop could
--    only happen after every reader had moved. Removing it first would have
--    failed the completeness check; dropping first would have made every
--    archive raise 'relation does not exist'."
-- Applied to THIS table: the manifest entry at lib/kernel/listing-archive.ts:291
--   { table: "property_interactions", column: "listing_id", disposition: "cascade" }
-- is removed ONLY AFTER this drop is applied AND the schema caches are
-- regenerated. This lane does NOT remove it — the integrator does, in that
-- order. (Readers moved first: that is this wave. Then drop. Then caches. Then
-- the manifest entry.)
--
-- ── NAME-COLLISION WARNING — must-NOT-touch ──────────────────────────────────
-- Two OTHER live tables wear this name as a substring and belong to DIFFERENT
-- lanes (see 062-long-tail-batch-3.sql:186-192):
--   · idx_property_interactions       (IDX telemetry, keyed on lead_id)
--   · lead_idx_property_interactions  (lead IDX telemetry, keyed on lead_id)
-- NOTHING in this file may pattern-match on '%property_interactions%'. Every
-- dependent below is dropped BY ITS EXACT NAME, and the two tables above (and
-- their indexes/policies, e.g. idx_lead_idx_property_interactions_lead_id) are
-- out of scope entirely.
--
-- ── WHY EXPLICIT DEPENDENTS INSTEAD OF CASCADE ───────────────────────────────
-- DROP TABLE ... CASCADE is too blunt: it deletes whatever happens to depend on
-- the table at apply time, including anything created since this file was
-- written, silently. Each dependent is named so nothing pattern-matched — and
-- nothing unexpected — dies. Inventory from the creation file
-- (060-long-tail-batch.sql:58-91):
--   trigger  property_interactions_set_brokerage_trg
--   function property_interactions_set_brokerage()
--   policies property_interactions_select / _insert / _update / _delete
--   indexes  idx_property_interactions_listing_type,
--            idx_property_interactions_contact
-- (The FKs contact_id→contacts, listing_id→listings, brokerage_id→brokerages
-- are constraints ON this table and fall with DROP TABLE; nothing FKs INTO
-- property_interactions — scripts/schema-fk-map.ts has no inbound edge.)
--
-- ── INTEGRATOR POST-APPLY CHECKLIST (in this order) ──────────────────────────
--   1. Regenerate the schema caches from the live DB (each generator's header
--      carries its SQL): scripts/schema-snapshot.ts (drops the
--      property_interactions entry at :530), scripts/schema-fk-map.ts (:609),
--      scripts/live-tables.ts (:573), scripts/check-vocabularies.ts (the
--      property_interactions CHECK vocabulary at :1245).
--   2. Remove the archive-manifest entry lib/kernel/listing-archive.ts:291 —
--      only now, per the ordering law above. Leave a tombstone naming
--      buyer_behavior_log (whose listing_id column keeps the behavior trail
--      reachable from a listing; it is not in the manifest because behavior
--      rows are the CONTACT's history, not the listing's children).
--   3. Remove "property_interactions" from scripts/agent-fk-columns.ts:409.
--   4. lib/kernel/manager-registry.ts:1954 — retire the
--      `property_interactions: "shopping_agent"` line with a tombstone naming
--      buyer_behavior_log as the survivor.
--   5. app/actions/email-campaigns.ts:919-930 — update the tombstone wording
--      from "The SIX surviving property_interactions readers are a SEPARATE
--      future lane" to: all repointed, table dropped (m598).
--   6. scripts/opposite-missing-baseline.json carries two entries for the
--      dropped table (property_interactions.interaction_type / .listing_id,
--      :253-254). After the cache regen the census reports them as burned —
--      tighten the baseline (OPPOSITE_MISSING_BASELINE=1) so a retired name
--      cannot sit in a ratchet reading as enforced (§2).

BEGIN;

-- Guard: the table must be EMPTY (zero-writer census says it always was).
-- Any row means a writer this migration's evidence did not see — stop and
-- explain the rows before retiring the table.
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.property_interactions;
  IF n <> 0 THEN
    RAISE EXCEPTION
      'm598 refused: property_interactions holds % row(s) but the zero-writer census expected 0 — find the writer before dropping',
      n;
  END IF;
END $$;

-- Dependents, by exact name (see the name-collision warning above).
DROP TRIGGER  IF EXISTS property_interactions_set_brokerage_trg ON public.property_interactions;
DROP FUNCTION IF EXISTS public.property_interactions_set_brokerage();

DROP POLICY IF EXISTS property_interactions_select ON public.property_interactions;
DROP POLICY IF EXISTS property_interactions_insert ON public.property_interactions;
DROP POLICY IF EXISTS property_interactions_update ON public.property_interactions;
DROP POLICY IF EXISTS property_interactions_delete ON public.property_interactions;

DROP INDEX IF EXISTS public.idx_property_interactions_listing_type;
DROP INDEX IF EXISTS public.idx_property_interactions_contact;

-- The table itself — plain DROP, no CASCADE, so anything unexpected still
-- depending on it refuses loudly instead of dying silently.
DROP TABLE public.property_interactions;

COMMIT;
