-- m533 — SIXTY-EIGHT TENANT ANCHORS THE DATABASE WAS NEVER ALLOWED TO ENFORCE
--
-- APPLICATION STATUS: APPLIED, 2026-08-23, by the integrator. Nothing in this
-- file deletes a row.
--
-- VERIFIED LIVE AFTER APPLYING:
--     RESTRICT foreign keys onto brokerages ......... 1 → 69  (+68, this file)
--     of those 68, not-valid ........................ 0
--
-- CONSEQUENCE THE NEXT READER MUST KNOW: with these 68 in place a hard
-- DELETE FROM brokerages now REFUSES (23503) instead of silently orphaning its
-- children. The two tenant-creation rollback paths were repaired in the same
-- wave — see lib/kernel/tenant-creation-rollback.ts — because before that
-- repair they neither deleted children first nor read the refusal.
--
-- ── THE FINDING ─────────────────────────────────────────────────────────────
-- The owner's ruling was "we need to include orphaned children." An orphaned
-- child is a row whose parent is gone, or whose parent-identifying column is NULL
-- so the parent can never be reached again. The precondition for that class is a
-- link the DATABASE IS NOT ENFORCING, and this schema has 490 of them: columns
-- shaped like a parent link, on 314 tables, carrying no foreign key at all.
--
-- The 68 below are the worst-shaped subset, because the parent they name is the
-- TENANT. A row whose brokerage_id points at a brokerage that is gone — or that
-- never existed, because nothing could refuse it — is not merely unreachable from
-- its parent. It is invisible to every tenant-scoped read in the product while
-- remaining fully present to the service-role client. It is billed to nobody,
-- audited by nobody, and reachable only by a query that names no tenant at all.
--
-- ── EVIDENCE, ALL MEASURED LIVE AGAINST hrvaqgvukzxfskkcrwbt ON 2026-08-22 ───
--
--   · WHICH PARENT: `brokerage_id` names `brokerages` in 599 of the 599 foreign
--     keys in this schema that use that column name. Unanimous. This is not a
--     name-mangling guess ("strip _id, pluralise"), which is the method that
--     mistakes `stripe_customer_id` and `elevenlabs_voice_id` for parent links —
--     it is a vote by the schema's own FK graph, and those external ids get no
--     vote because they carry no FK anywhere.
--
--   · HOW MANY ROWS THIS TOUCHES — EXACTLY. Across all 68 tables:
--         total rows              1   (a single transaction_lenders row)
--         rows with a brokerage_id 1
--         ORPHANED rows            0
--     So every ADD CONSTRAINT below validates against one row and refuses none.
--     The migration is safe today and its whole value is prospective.
--
--   · A ZERO HERE IS WEAK EVIDENCE AND IS REPORTED AS SUCH (CLAUDE.md §2). The
--     live database holds 2 brokerages, 4 contacts and 0 leads; almost every one
--     of these 68 tables is empty. The STRUCTURAL question — "can this orphan?" —
--     is what this migration answers, and it answers YES for all 68 regardless of
--     today's row count.
--
--   · NOT-VALID CONSTRAINTS: none. All 1784 existing foreign keys are
--     convalidated, so no constraint is silently admitting bad rows. The gap is
--     entirely constraints that were never written.
--
-- ── WHY `ON DELETE RESTRICT` AND NOT `SET NULL` ─────────────────────────────
-- `SET NULL` is the rule this repo already reaches for: 401 of the 1784 existing
-- foreign keys use it onto a nullable column, and 68 of those are brokerage_id →
-- brokerages. That rule DOES NOT DELETE THE CHILD — it erases the child's
-- parentage and leaves the row alive and tenant-less. Adding 68 more of those
-- would be adding 68 more orphan factories under the name of a fix.
--
-- RESTRICT refuses instead, which is the fail-closed choice (CLAUDE.md §4) and
-- costs nothing on the live product path: brokerage deletion is SOFT everywhere
-- (`deleted_at`, e.g. lib/platform/provider-posture.ts:177 and every cron that
-- enumerates tenants). There are exactly TWO hard `.from("brokerages").delete()`
-- calls in the tree and both are creation-rollback paths:
--     app/actions/admin/create-subscriber.ts:94
--     app/actions/auth/signup-brokerage.ts:193
-- INTEGRATOR: those two paths must delete their children first, or be converted
-- to the soft path, BEFORE this is applied — otherwise a failed signup leaves a
-- brokerage row that RESTRICT will not let the rollback remove. That is a
-- deliberate trade: a rollback that fails loudly beats a rollback that silently
-- strands rows in no tenant.
--
-- ── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────────
-- It does not touch the 401 EXISTING `ON DELETE SET NULL` constraints. Changing
-- the delete rule on a constraint that already exists is a behaviour change to
-- live cascades across 68 tables including contacts, listings, transactions and
-- users, and it is the owner's call, not a lane's. It is reported by
-- `npm run test:orphaned-children` as OC2 with the exact counts so the decision
-- has its numbers.
--
-- It does not add the other 422 unprotected links. They resolve to eleven
-- different parents with different cardinalities and different product meanings,
-- and a 490-constraint migration is not reviewable. This one is: one parent, one
-- rule, one measured row count.
--
-- NO EXPLICIT BEGIN/COMMIT — the migration runner already wraps this file in a
-- transaction, and a COMMIT here would close the OUTER one early, so the 68 adds
-- would stop being all-or-nothing.

DO $$
DECLARE
  t text;
  n int := 0;
  targets text[] := ARRAY[
    'agent_retention_scores','agent_tax_profile','agentic_invocation_log','ai_generated_content',
    'ai_isa_calls','ai_listing_optimizations','brokerage_cda_template_fields','buyer_move_cases',
    'calendar_events','call_analyses','call_coaching_insights','call_transcriptions','challenges',
    'client_friendly_updates','client_portal_messages','closing_checklist_items',
    'compliance_checklists','contact_property_insights','cost_breakdown_tracking',
    'deal_health_components','deal_health_scores','deal_team_members','document_classifications',
    'document_extraction_log','email_queue','inbound_call_classifications','investor_deal_matches',
    'journey_stage_progress','mentor_sessions','newsletter_cadence_policy','newsletter_teasers',
    'podcast_show_settings','presentation_sections','proactive_interventions','reaper_runs',
    'saved_ai_outputs','scheduled_touchpoints','self_heal_events','signal_reactivations',
    'smart_checklists','social_cadence_policy','task_items','timeline_transparency',
    'title_company_users','transaction_closing_prep','transaction_commissions',
    'transaction_communications','transaction_compliance_log','transaction_cost_breakdown',
    'transaction_deadlines','transaction_documents','transaction_health_factors',
    'transaction_inspections','transaction_lenders','transaction_participants',
    'transaction_repair_negotiations','transaction_tasks','transaction_timeline',
    'transaction_title_escrow','transaction_vendor_services','user_uploaded_videos',
    'vendor_bookings','vendor_ratings','vendor_review_flags','vendor_tax_documents',
    'voice_assistant_config','voice_assistant_sessions','weekly_plans'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    -- IDEMPOTENT AND FAIL-SOFT ON SHAPE, HARD ON DATA. If the table or the column
    -- is gone, or another lane has already added the constraint, this skips. It
    -- does NOT skip a validation failure: a genuinely orphaned row must stop the
    -- migration rather than be quietly excused.
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'brokerage_id' AND NOT a.attisdropped
      WHERE c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'm533: skipping %, no such table or no brokerage_id column', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND c.relname = t AND a.attname = 'brokerage_id'
    ) THEN
      RAISE NOTICE 'm533: skipping %, brokerage_id already has a foreign key', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (brokerage_id) '
      'REFERENCES public.brokerages(id) ON DELETE RESTRICT',
      t, t || '_brokerage_id_fkey'
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'm533: added % brokerage_id foreign key(s) of 68 expected', n;
END
$$;

-- AFTER APPLYING: regenerate the schema caches. They are GENERATED, NEVER
-- HAND-EDITED (CLAUDE.md §3) — `npm run schema:regen` — because
-- scripts/schema-fk-map.ts is the offline oracle that
-- scripts/orphaned-child-census.ts reads, and until it is regenerated the census
-- will keep reporting all 68 of these as unprotected. That is the correct
-- behaviour for a cache, not a bug: the file is not the database.
--
-- THEN retighten the census baseline:
--   ORPHANED_CHILD_BASELINE=1 npx tsx scripts/orphaned-child-census.ts
-- Expected movement: OC1 falls by the number of these 68 tables that are in
-- scripts/schema-snapshot.ts (the cache is `referenced ∩ live`, so tables the
-- code never queries are not counted there in the first place). The direction is
-- DOWN and the cause is "the database was given the constraint" — not a deletion,
-- and not a blinded scanner.
