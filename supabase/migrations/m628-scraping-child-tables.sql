-- m628 — THE NINE SCRAPING lead_id LINKS (OC1 BURN-DOWN, LANE 64D AUDIT)
--
-- ── APPLIED LIVE 2026-09-15 on hrvaqgvukzxfskkcrwbt via mcp apply_migration (m628_scraping_child_tables) ──
--
-- Applied by the integrator on 2026-09-15 (m628: 9 FKs added, no orphan rows refused it). Lanes write
-- migrations; only the integrator applies them and regenerates the schema
-- caches (CLAUDE.md §3/§7).
--
-- ── SCOPE: THE 9 SCRAPING lead_id ENTRIES m608 AND m611 LEFT FROZEN ─────────
-- m608 froze 16 lead_id links under one umbrella ("owner-frozen lead-scraping/
-- sourcing surface"). m611 carved out and fixed the 7 that were NOT actually
-- scraping tables, leaving these 9 untouched on purpose — the real scraping/
-- intelligence surface:
--
--   google_search_activity.lead_id
--   lead_behavioral_data.lead_id
--   lead_intelligence.lead_id
--   lead_osint_data.lead_id
--   lead_people_data.lead_id
--   lead_property_ownership.lead_id
--   lead_property_searches.lead_id
--   motivated_seller_signals.lead_id
--   nextdoor_activity.lead_id
--
-- Lane 64D's brief (2026-09-15) explicitly LIFTS the scraping freeze for this
-- one audit task — schema-only, no lib/lead-pipeline/*, lib/external/*,
-- app/api/cron/lead-scraping, lib/kernel/scraping.ts or
-- app/actions/lead-intelligence.ts file was edited to produce this migration.
--
-- ── VERDICT, ALL NINE: BUILD THE FK (no duplicate exists; §1.2) ─────────────
-- scripts/orphaned-child-census.ts OC1 (`npm run test:orphaned-children --list`)
-- flags all nine, each with the SAME evidence: the consensus oracle agrees
-- `lead_id` means `leads.id` 44/44 times everywhere else it appears in this
-- schema, and none of these nine carries a foreign key today, so a value
-- naming a leads row that is gone can never be refused or reported.
--
-- Per-table writer confirmation (grepped `.insert(`/`.upsert(`, 2026-09-15) —
-- every one of the nine has a LIVE writer, and all nine share the same one:
-- app/actions/lead-intelligence.ts (a file this migration does not edit —
-- lane A/B/C territory). Each write passes `lead_id: leadId`, where `leadId`
-- is the same identifier used two statements earlier against
-- `.from("leads")...eq("id", leadId)` in the same function
-- (createGoogleSearchActivity / upsertLeadIntelligence / the OSINT, people,
-- ownership, property-search, motivated-seller and Nextdoor writers), so the
-- value written is provably a `leads.id` at the point it is written:
--
--   google_search_activity   — app/actions/lead-intelligence.ts:1001
--   lead_behavioral_data     — lib/lead-scoring/record-behavioral-event.ts:123
--   lead_intelligence        — app/actions/lead-intelligence.ts:1517
--   lead_osint_data          — app/actions/lead-intelligence.ts:905
--   lead_people_data         — app/actions/lead-intelligence.ts:886
--   lead_property_ownership  — app/actions/lead-intelligence.ts:953
--   lead_property_searches   — app/actions/lead-intelligence.ts:1066
--   motivated_seller_signals — app/actions/lead-intelligence.ts:1375 (+5 more
--                               callers across lib/predictive-listing/,
--                               lib/external/batchdata-seller-signals.ts,
--                               lib/external/permit-signals.ts — all pass a
--                               `leadId`/`lead_id` sourced from a real lead row)
--   nextdoor_activity        — app/actions/lead-intelligence.ts:1036
--
-- No wrong-parent case (unlike tax_categories.provider_account_id, m611's own
-- out-of-scope finding) — the consensus and the writer evidence agree.
--
-- ── ON DELETE RESTRICT, same reasoning as m533/m608/m611 ────────────────────
-- Fail-closed default (CLAUDE.md §4). No product ruling asks for a cascade or
-- a nulled parentage on these nine (a cascade would let a `leads` delete
-- silently vaporize scraping/intelligence evidence; a SET NULL would erase
-- parentage, exactly the OC2 shape this migration must not add more of).
-- A hard `DELETE FROM leads` was grepped across the whole tree
-- (`from("leads").delete()` / `from("leads")\n.delete()`) and found ONLY in
-- scripts/e2e-lifecycle-harness.ts (test-harness cleanup, not a
-- request-serving path) — so RESTRICT costs nothing live today, matching
-- m608's and m611's identical finding for their own tables.
--
-- ── ROW-COUNT / ORPHAN EVIDENCE: MEASURED BEFORE APPLYING (RUN THIS FIRST) ──
-- This lane holds no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (CLAUDE.md §7
-- forbids lanes from applying migrations regardless), so the live orphan
-- count behind each of the nine links below was NOT measured. Before
-- applying, run one of these per table (mirrors m608/m611's own pre-flight):
--
--   select count(*) from public.google_search_activity c
--     left join public.leads p on p.id = c.lead_id
--    where c.lead_id is not null and p.id is null;
--
--   select count(*) from public.lead_behavioral_data c
--     left join public.leads p on p.id = c.lead_id
--    where c.lead_id is not null and p.id is null;
--
--   select count(*) from public.lead_intelligence c
--     left join public.leads p on p.id = c.lead_id
--    where c.lead_id is not null and p.id is null;
--
--   select count(*) from public.lead_osint_data c
--     left join public.leads p on p.id = c.lead_id
--    where c.lead_id is not null and p.id is null;
--
--   select count(*) from public.lead_people_data c
--     left join public.leads p on p.id = c.lead_id
--    where c.lead_id is not null and p.id is null;
--
--   select count(*) from public.lead_property_ownership c
--     left join public.leads p on p.id = c.lead_id
--    where c.lead_id is not null and p.id is null;
--
--   select count(*) from public.lead_property_searches c
--     left join public.leads p on p.id = c.lead_id
--    where c.lead_id is not null and p.id is null;
--
--   select count(*) from public.motivated_seller_signals c
--     left join public.leads p on p.id = c.lead_id
--    where c.lead_id is not null and p.id is null;
--
--   select count(*) from public.nextdoor_activity c
--     left join public.leads p on p.id = c.lead_id
--    where c.lead_id is not null and p.id is null;
--
-- A nonzero count on any pair means real orphaned rows exist and `ADD
-- CONSTRAINT` below will refuse to apply (fail loud) until they are repaired
-- or nulled — expected and correct per CLAUDE.md §1 (never delete a row to
-- move a number).
--
-- ── NOT TOUCHED, REPORTED NOT SILENCED ───────────────────────────────────────
-- motivated_seller_signals is also DUAL-KEYED (contact_id alongside lead_id —
-- lib/contact-promotion/history-carry.ts's REPOINTED_HISTORY_TABLES already
-- carries it, per OC3, which reports 0 findings for it). This migration only
-- adds the missing lead_id FK; it does not touch the contact_id side, which
-- already has its own protection via the carry list.
--
-- AFTER APPLYING: regenerate the schema caches (CLAUDE.md §3) with
-- `npm run schema:regen`, then retighten:
--   ORPHANED_CHILD_BASELINE=1 npx tsx scripts/orphaned-child-census.ts
-- Expected movement: OC1 falls by up to 9 (bounded, as m608/m611 noted for
-- their own tables, by how many of these 9 survive in
-- scripts/schema-snapshot.ts, which is `referenced ∩ live`). Direction is
-- DOWN, cause is "the database was given the constraint" — never a deletion.

-- ── lead_id → leads (9 scraping/intelligence tables) ────────────────────────
DO $$
DECLARE
  t text;
  n int := 0;
  targets text[] := ARRAY[
    'google_search_activity',
    'lead_behavioral_data',
    'lead_intelligence',
    'lead_osint_data',
    'lead_people_data',
    'lead_property_ownership',
    'lead_property_searches',
    'motivated_seller_signals',
    'nextdoor_activity'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'lead_id' AND NOT a.attisdropped
      WHERE c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'm628: skipping %, no such table or no lead_id column', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND c.relname = t AND a.attname = 'lead_id'
    ) THEN
      RAISE NOTICE 'm628: skipping %, lead_id already has a foreign key', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (lead_id) '
      'REFERENCES public.leads(id) ON DELETE RESTRICT',
      t, t || '_lead_id_fkey'
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'm628: added % lead_id -> leads foreign key(s) of 9 expected', n;
END
$$;
