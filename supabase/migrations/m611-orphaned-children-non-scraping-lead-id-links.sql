-- m611 — SEVEN NON-SCRAPING lead_id LINKS (OC1 BURN-DOWN, SCOPED LANE Y)
--
-- Nothing in this file has been run against hrvaqgvukzxfskkcrwbt. Lanes write
-- migrations; only the integrator applies them and regenerates the schema
-- caches (CLAUDE.md §3/§7).
--
-- ── SCOPE: THE 7 NON-SCRAPING lead_id ENTRIES NAMED FOR THIS LANE ───────────
-- m608 froze all 16 of these under one umbrella ("owner-frozen lead-scraping/
-- sourcing surface"). This lane's brief narrows that: the nine lead_osint_data /
-- lead_people_data / nextdoor_activity / google_search_activity /
-- motivated_seller_signals / lead_intelligence / lead_property_ownership /
-- lead_property_searches / lead_behavioral_data columns are the actual
-- scraping/sourcing surface and STAY FROZEN — untouched here. The other seven
-- m608 swept into the same freeze are not scraping tables at all:
--
--   audience_members.lead_id            — marketing/audience membership
--   campaign_bundle_dispatches.lead_id  — direct-mail/campaign dispatch audit
--   communication_audit_log.lead_id     — compliance comms trail
--   lead_deduplication_log.lead_id      — dedup decision log
--   lead_engagement_scores.lead_id      — lead scoring snapshot
--   outcome_reconciliations.lead_id     — send-outcome reconciliation ledger
--   unified_lead_profile.lead_id        — AI intent/triage profile
--
-- All seven vote leads 37/37 in the consensus oracle (scripts/orphaned-child-
-- census.ts) and none has any product ruling asking for a different parent, so
-- FK protection is the correct fix for all seven — BUT the writer investigation
-- below found three of them have NO LIVE WRITER for lead_id at all (only for a
-- differently-named column, or none). That is a §1 finding reported beside the
-- fix, not a reason to skip the fix: a column nobody writes today is not a
-- column nobody will ever write, and the database should refuse a bad value on
-- it exactly as readily as one with an active writer.
--
-- ── PER-COLUMN INVESTIGATION (writers grepped `.insert(`/`.upsert(`/`.update(`,
--    migrations, callers) ─────────────────────────────────────────────────────
--
--   audience_members.lead_id — DEAD WRITE PATH, already corrected once.
--     lib/audiences/audience-sync.ts:onLeadConvertedForAudience only ever
--     inserts `contact_id` (Wave 38 correction, m165 — FB Custom Audiences
--     requires consent, which a lead does not have; membership begins at
--     conversion). m165 marked pre-correction lead-only rows sync_status=
--     'removed' and dropped lead_id from the unique key. No reachable writer
--     sets lead_id today. Historical rows, if any survive, were written
--     against real leads.id by the pre-m165 code path.
--     VERDICT: BUILD the FK (protects any future/legacy value; costs nothing
--     against the live write path since nothing writes it).
--
--   campaign_bundle_dispatches.lead_id — live column, dead in practice.
--     lib/direct-mail/orchestrate-bundle-send.ts:125 writes
--     `lead_id: args.leadId ?? null`, and its ONLY caller,
--     app/actions/campaign-bundle-dispatch.ts:sendCampaignBundleToContactAction,
--     never supplies `leadId` in its call at line 101-120 (contact-only send) —
--     so every live row gets NULL here. The plumbing exists for a lead-side
--     dispatch that has no caller yet.
--     VERDICT: BUILD the FK — the column is contractually a leads.id
--     (args.leadId, typed and named as one) even though nothing populates it
--     on the one live path.
--
--   communication_audit_log.lead_id — WRITERLESS (§1 finding, reported).
--     The sole surviving writer (tombstoned at
--     lib/application/compliance-monitoring.ts:1223, survivor
--     lib/services/communication.service.tsx:logCommunication:254) inserts
--     brokerage_id/contact_id/agent_id/communication_type/channel/subject/
--     body_snippet/lead_temperature/was_approved_content/compliance_passed/
--     sent_at — never lead_id. The table is in REPOINTED_HISTORY_TABLES
--     (lib/contact-promotion/history-carry.ts), so OC3's carry step runs a
--     `.update({contact_id}).eq("lead_id", leadId)` against it on every
--     conversion; today that always matches zero rows because lead_id is never
--     set. Not a wrong-parent case — nothing writes ANY id here to be wrong.
--     VERDICT: BUILD the FK regardless (consensus is leads 37/37, and a
--     writerless column is not a reason to leave a parent-shaped column
--     unprotected — a future writer, or a hand-run UPDATE, gets the same
--     guarantee every other lead_id column has).
--
--   lead_deduplication_log.lead_id — WRITERLESS WRITE, WRITERLESS READ (§1 x2).
--     Both live writers — lib/kernel/crm.ts:234 (dedup-log the merge decision)
--     and lib/kernel/scraping.ts:866 (logDedupDecision) — write
--     `duplicate_of_contact_id` / `duplicate_of_lead_id`, never the bare
--     `lead_id` column. But app/api/leads/deduplication-log/route.ts:67-70
--     FILTERS reads on `lead_id` (`.eq("lead_id", lead_id)` and
--     `.in("lead_id", scopedIds.leadIds)`) — a read with no writer, the other
--     half of the same orphan doctrine (§1). That reader has always returned
--     zero rows for any lead-scoped caller; team_lead / ai_isa readers get an
--     empty page where they should see dedup history keyed by
--     duplicate_of_lead_id. THIS IS A READER BUG, NOT AN FK GAP, and fixing
--     app/api/leads/deduplication-log/route.ts is out of this migration's
--     scope (it is code, not schema) — reported here and separately, not
--     silently left for the next lane to rediscover.
--     VERDICT: BUILD the FK on lead_id anyway (safe — the column holds no
--     values from any live writer, so no data can violate it) AND report the
--     writerless-read defect above.
--
--   lead_engagement_scores.lead_id — LIVE WRITER, CONFIRMED CORRECT.
--     lib/services/lead-management.service.ts:441 writes
--     `lead_id: params.id` in the branch that just updated the SAME id via
--     `.from("leads").update(...).eq("id", params.id)` two statements above
--     (line 408-416) — so `params.id` is provably a `leads.id` at the point it
--     is written into this column.
--     VERDICT: BUILD the FK.
--
--   outcome_reconciliations.lead_id — LIVE WRITER, CONFIRMED CORRECT.
--     lib/outcomes/reconciliation-ledger.ts:recordOutcomeClaim writes
--     `lead_id: input.leadId ?? null` (line 81); its two callers,
--     lib/providers/dispatch.ts:680 (SMS) and :1095 (direct mail), forward
--     `params.leadId` straight through from the outbound-dispatch caller
--     alongside `params.contactId` — the two id classes travel side by side
--     through the whole dispatch path and neither is ever substituted for the
--     other. Also in REPOINTED_HISTORY_TABLES: the OC3 carry step re-points
--     contact_id here at conversion, keeping lead_id (line 80-81 of
--     history-carry.ts).
--     VERDICT: BUILD the FK.
--
--   unified_lead_profile.lead_id — WRITERLESS (§1 finding, reported).
--     The one insert path, app/actions/lead-intelligence.ts:
--     createUnifiedLeadProfile (line 2014-2029), writes brokerage_id/
--     contact_id/lead_source/confidence_score/intent_type/intent_strength/
--     first_detected_date/contact_email/contact_phone/enrichment_sources —
--     never lead_id, and grep across the tree finds no other writer and no
--     reader that filters on it either (unlike lead_deduplication_log's read-
--     with-no-writer, this column has neither side). Also in
--     REPOINTED_HISTORY_TABLES, so the OC3 carry's `.eq("lead_id", leadId)`
--     update against this table is a permanent no-op today for the same
--     reason as communication_audit_log above.
--     VERDICT: BUILD the FK regardless, same reasoning as
--     communication_audit_log.
--
-- ── ON DELETE RESTRICT, same reasoning as m533/m608 ─────────────────────────
-- Fail-closed default (CLAUDE.md §4). No product ruling here asks for a
-- cascade or a nulled parentage (the OC2 category is exactly the "erases
-- parentage" shape this migration must not add more of). A hard
-- `DELETE FROM leads` was grepped across the whole tree
-- (`from("leads").delete()` / `from("leads")\n.delete()`) and found ONLY in
-- scripts/*-simulator.ts and scripts/demo-seed-and-run.ts — no request-serving
-- path — so RESTRICT costs nothing live today, matching m608's identical
-- finding for its nine parent tables.
--
-- ── ROW-COUNT / ORPHAN EVIDENCE: MEASURED BEFORE APPLYING (RUN THIS FIRST) ──
-- This lane holds no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (CLAUDE.md §7
-- forbids lanes from applying migrations regardless), so the live orphan count
-- behind each of the seven links below was NOT measured. Before applying, run
-- one of these per pair (mirrors m533/m608's own pre-flight):
--
--   select count(*) from public.audience_members c
--     left join public.leads p on p.id = c.lead_id
--    where c.lead_id is not null and p.id is null;
--
--   select count(*) from public.campaign_bundle_dispatches c
--     left join public.leads p on p.id = c.lead_id
--    where c.lead_id is not null and p.id is null;
--
--   select count(*) from public.communication_audit_log c
--     left join public.leads p on p.id = c.lead_id
--    where c.lead_id is not null and p.id is null;
--
--   select count(*) from public.lead_deduplication_log c
--     left join public.leads p on p.id = c.lead_id
--    where c.lead_id is not null and p.id is null;
--
--   select count(*) from public.lead_engagement_scores c
--     left join public.leads p on p.id = c.lead_id
--    where c.lead_id is not null and p.id is null;
--
--   select count(*) from public.outcome_reconciliations c
--     left join public.leads p on p.id = c.lead_id
--    where c.lead_id is not null and p.id is null;
--
--   select count(*) from public.unified_lead_profile c
--     left join public.leads p on p.id = c.lead_id
--    where c.lead_id is not null and p.id is null;
--
-- A nonzero count on any pair means real orphaned rows exist and `ADD
-- CONSTRAINT` below will refuse to apply (fail loud) until they are repaired
-- or nulled — expected and correct per CLAUDE.md §1 (never delete a row to
-- move a number).
--
-- ── OUT OF SCOPE, REPORTED NOT SILENCED ──────────────────────────────────────
--
--   tax_categories.provider_account_id — WRONG-PARENT FINDING, unresolved.
--     Consensus votes calendar_provider_accounts 3/3, but the real column,
--     per lib/finance/accounting-egress.ts:10-11,64,76 and
--     app/actions/accounting-sync.ts, holds a QuickBooks/Xero EXTERNAL
--     account id keyed by category_name — the same shape as
--     `stripe_customer_id`, colliding in NAME only with the calendar-sync
--     tables' unrelated `provider_account_id`. Already named in m608's own
--     scope note with the identical conclusion. NO FK ADDED — wiring
--     `REFERENCES calendar_provider_accounts(id)` would wire the wrong
--     parent, which CLAUDE.md §1 forbids exactly as it forbids deleting to
--     move a number. Fix is a §6 rename of one of the two colliding columns,
--     or teaching the consensus oracle about the collision — neither is a
--     migration this lane can write without picking which column loses its
--     name.
--
--   vendor_subscriptions.brokerage_id — CACHE DRIFT, not a missing FK.
--     scripts/orphaned-child-census.ts's own [recorded] block already states
--     `vendor_subscriptions_brokerage_id_fkey` exists live
--     (→ public.brokerages, ON DELETE CASCADE) and that
--     scripts/schema-fk-map.ts has simply not absorbed it. NO MIGRATION
--     WRITTEN — CLAUDE.md §3: schema caches are GENERATED, NEVER
--     HAND-EDITED. Fix is `npm run schema:regen` against live credentials,
--     which this lane does not hold and is not permitted to run.
--
--   journey_states.user_id — RULING ALREADY RECORDED, confirmed, skipped.
--     m610 rules it STAYS TEXT: it is not a user id, it is
--     lib/kernel/dual-intent-linker.ts's composite key
--     `${contactId}:buyer` / `${contactId}:seller` under a live
--     UNIQUE(user_id). A uuid cast or an FK to users(id) would destroy the
--     design. No change here.
--
--   brokerage_id:on_delete_set_null (OC2) — ALREADY FIXED, STALE FINDING.
--     scripts/orphaned-child-census.ts hardcodes this single OC2 finding from
--     a DECLARATION dated 2026-08-22 (SET_NULL_MEASURED_ON /
--     SET_NULL_DECLARED). supabase/migrations/m535-set-null-does-not-delete-
--     a-child-it-erases-the-tenant-that-owns-it.sql is now marked, by its own
--     banner, APPLIED — measured 2026-09-04 against
--     hrvaqgvukzxfskkcrwbt's migration ledger. m535's PART 1 converts EVERY
--     `brokerage_id → brokerages ON DELETE SET NULL` foreign key to RESTRICT,
--     derived live from pg_constraint at apply time (not a hardcoded table
--     list), and its own postflight assertion (lines 257-272) RAISES an
--     EXCEPTION if even one such constraint remains after it runs. So if
--     m535 is applied — and its own header says it is — the live count of
--     brokerage_id SET NULL constraints onto brokerages is 0, not the 68
--     this census's SET_NULL_DECLARED still states.
--
--     WHY NO ALTER IS WRITTEN HERE (CLAUDE.md §1 — duplicate exists, merge
--     onto the survivor, then tombstone; never re-do the same fix twice):
--     m535 IS the fix this task asked for, already applied, with the exact
--     RESTRICT-not-CASCADE justification this task asked to see (its own
--     "WHY RESTRICT, AND NOT CASCADE" section, lines 144-158: RESTRICT can
--     never destroy data by accident; brokerage deletion is soft everywhere
--     in this tree; and issuing a second delete rule on the same column name
--     would itself be the §6 defect — two spellings of one idea). Re-adding
--     the same ALTER here would either no-op (constraint already RESTRICT,
--     the DO block below skips it) or, worse, mask a real drift by looking
--     like independent evidence when it is copying m535's own claim.
--
--     WHAT THIS MIGRATION DOES INSTEAD: a read-only assertion, safe to run
--     standalone or alongside the ADD CONSTRAINT blocks above, that PROVES
--     the census's OC2 finding is stale rather than asking the integrator to
--     trust this paragraph. If m535 has NOT actually landed (this lane could
--     not verify — no live credentials), the assertion RAISES NOTICE with
--     the live count instead of silently assuming zero, so the integrator
--     sees the true state either way.
--
--     THE FIX FOR THE CENSUS ITSELF — updating SET_NULL_DECLARED /
--     SET_NULL_MEASURED_ON in scripts/orphaned-child-census.ts to a fresh
--     live measurement — is NOT done here. It is a measurement change to a
--     guard script, not a schema migration, and CLAUDE.md §7 asks for
--     verification before claiming; this lane holds no live credentials to
--     re-measure the other six SET_NULL_DECLARED columns (contact_id,
--     agent_id, transaction_id, team_id, lead_id, listing_id) that were not
--     in scope here, so touching one row of that table without re-measuring
--     the rest would trade one stale number for a partially-stale one.
--     Reported for the integrator, who holds the credentials m535's own
--     banner was verified with.
--
-- AFTER APPLYING: regenerate the schema caches (CLAUDE.md §3) with
-- `npm run schema:regen`, then retighten:
--   ORPHANED_CHILD_BASELINE=1 npx tsx scripts/orphaned-child-census.ts
-- Expected movement: OC1 falls by up to 7 (bounded, as m608 noted for its own
-- 80, by how many of these 7 tables survive in scripts/schema-snapshot.ts,
-- which is `referenced ∩ live`). Direction is DOWN, cause is "the database was
-- given the constraint" — never a deletion. The oc2 brokerage_id finding
-- should already read 0 if m535 is truly applied; if it still reads 1 after
-- this file's assertion block reports 0 remaining SET NULL constraints, the
-- census's own declaration is what needs updating, not the schema.

-- ── lead_id → leads (7 tables) ──────────────────────────────
DO $$
DECLARE
  t text;
  n int := 0;
  targets text[] := ARRAY[
    'audience_members',
    'campaign_bundle_dispatches',
    'communication_audit_log',
    'lead_deduplication_log',
    'lead_engagement_scores',
    'outcome_reconciliations',
    'unified_lead_profile'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'lead_id' AND NOT a.attisdropped
      WHERE c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'm611: skipping %, no such table or no lead_id column', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND c.relname = t AND a.attname = 'lead_id'
    ) THEN
      RAISE NOTICE 'm611: skipping %, lead_id already has a foreign key', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (lead_id) '
      'REFERENCES public.leads(id) ON DELETE RESTRICT',
      t, t || '_lead_id_fkey'
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'm611: added % lead_id -> leads foreign key(s) of 7 expected', n;
END
$$;

-- ── OC2 ASSERTION-ONLY: prove the census's brokerage_id:on_delete_set_null
--    finding is stale (m535 already applied) rather than re-doing its ALTER.
--    NO SCHEMA CHANGE IN THIS BLOCK — read-only, safe to run even if m535
--    never landed (it only RAISEs, it never fails the transaction).
DO $$
DECLARE remaining int;
BEGIN
  SELECT count(*) INTO remaining
  FROM pg_constraint c
  JOIN pg_class src ON src.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = src.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.contype = 'f' AND c.confdeltype = 'n' AND n.nspname = 'public'
    AND a.attname = 'brokerage_id' AND c.confrelid = 'public.brokerages'::regclass;

  IF remaining = 0 THEN
    RAISE NOTICE 'm611: OC2 brokerage_id:on_delete_set_null is CONFIRMED STALE — 0 brokerage_id->brokerages FKs remain ON DELETE SET NULL (m535 already converted them to RESTRICT). The census declaration (scripts/orphaned-child-census.ts SET_NULL_DECLARED, dated 2026-08-22) needs a fresh measurement, not a new migration.';
  ELSE
    RAISE NOTICE 'm611: OC2 WARNING — % brokerage_id->brokerages FK(s) STILL ON DELETE SET NULL. m535''s own banner claims APPLIED; if this fires, either m535 has not actually run or a new tenant anchor FK was added after it did. Re-run m535''s PART 1 loop, do not hand-write a one-off ALTER here.', remaining;
  END IF;
END
$$;
