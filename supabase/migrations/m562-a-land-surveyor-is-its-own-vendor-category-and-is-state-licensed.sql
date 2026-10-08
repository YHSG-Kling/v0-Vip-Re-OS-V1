-- m562 — A LAND SURVEYOR IS ITS OWN VENDOR CATEGORY, AND IS STATE LICENSED
-- =============================================================================
--
-- OWNER RULING, verbatim:
--
--   "surveyor is a vendor category"
--
-- This closes the one thing m561 left open BY NAME. Its section headed
-- "RULING 2: `surveyor` IS UNRESOLVED, AND IS NOT FOLDED" says, at
-- supabase/migrations/m561-service-type-was-a-second-spelling-of-the-vendor-trade-and-escrow-is-a-spelling-of-title.sql
-- line 105:
--
--   "Whether to widen both twins for it the way m554 widened them for
--    `appraiser` is an OWNER call, and it is recorded here rather than guessed.
--    UNRESOLVED."
--
-- The owner has now made that call. m561 declined to guess; this migration is
-- not a guess.
--
-- ── WHAT WAS MEASURED LIVE BEFORE WRITING THIS (2026-08-25, hrvaqgvukzxfskkcrwbt) ──
--
--   · public.vendors_category_check                      39 values, no 'surveyor'
--   · public.vendor_service_areas_trade_category_check   39 values, no 'surveyor'
--     …and the two lists are BYTE-IDENTICAL, in the same order — still true after
--     m554 widened them and m561 deliberately moved neither.
--   · public.vendor_trade_requires_state_license('surveyor') = false
--
--   TWO-SIDED CONTROL, run live before applying, inside a DO block ending in
--   RAISE so nothing was left behind (the m554/m561 pattern):
--
--     vendors.category    surveyor         = REFUSED(23514)
--     vsa.trade_category  surveyor         = REFUSED(23514)
--     vendors.category    appraiser        = ADMITTED
--     vsa.trade_category  appraiser        = ADMITTED
--     vendors.category    not_a_real_trade = REFUSED(23514)
--     vsa.trade_category  not_a_real_trade = REFUSED(23514)
--
--   `not_a_real_trade` is the POSITIVE CONTROL (CLAUDE.md §2): `surveyor` being
--   refused only means something while a CHECK is still there to refuse it, and
--   after this migration `surveyor` must be ADMITTED **while `not_a_real_trade`
--   is still REFUSED** — otherwise a widened vocabulary is indistinguishable
--   from a dropped constraint. `appraiser` is the second control, in the other
--   direction: it proves the probe can see an ADMITTED value at all, so a
--   REFUSED answer is the CHECK talking and not a broken fixture.
--
--   Both vocabularies were read back with cardinality DERIVED from
--   pg_get_constraintdef rather than counted off the literals typed below, so
--   the 39 → 40 claim is the database's number and not this file's.
--
--   BLAST RADIUS, measured before applying: vendors=1, vendor_service_areas=0,
--   vendor_marketplace_profiles=0, contacts=4, brokerages=2, leads=0,
--   ai_tool_usage=23. Nothing live holds either column, so widening the two
--   CHECKs cannot invalidate an existing row, and putting the trade behind the
--   licence gate takes no existing booking dark.
--
-- ── WHY BOTH VOCABULARIES MOVE IN ONE MIGRATION ──────────────────────────────
--
-- Unchanged from m551/m554, and restated because it is the rule this pair keeps
-- breaking: they are TWO SPELLINGS OF ONE TAXONOMY (CLAUDE.md §6). A CHECK
-- cannot reference another table, so the list is written out twice and
-- scripts/vendor-service-area-simulator.ts asserts the two are IDENTICAL.
-- Widening only one gives a vendor a trade the bench can express but the
-- coverage table cannot — so no licence could ever be filed for it and
-- vendor_bookable_in_state would answer 'vendor_coverage_unknown' forever — or a
-- coverage row for a trade no bench row can hold. BOTH, OR NEITHER.
--
-- ── WHY `surveyor` IS ADDED WHERE `escrow` WAS NOT ──────────────────────────
--
-- m561 refused `escrow` and recorded `surveyor` as open in the same breath, and
-- the difference between the two cases is the whole reason one is a fortieth
-- value and the other never will be. `escrow` ALREADY HAD A HOME: four
-- independent writers (transaction_title_escrow's one row holding both officers,
-- deposits.escrow_company with no vendors FK, vendor_assignments.assignment_type
-- carrying `title` and never `escrow`, and lib/compliance/vendor-respa.ts
-- folding it into the title settlement bucket) already treat escrow as a ROLE AT
-- the title company. Adding it would have MADE a §6 defect: a bench holding an
-- `escrow` row and a `title` row that are the same firm.
--
-- `surveyor` has the opposite shape, and it is the `appraiser` shape exactly: a
-- distinct profession, separately licensed, that is not a spelling of any of the
-- 39 and has NO home among them. A boundary survey is not an appraisal, not an
-- inspection and not title work — it is the measurement the other three cite.
-- It was NOT folded into `other`, deliberately, and m561 said why: filing a real
-- trade under the catch-all makes the vocabulary look complete while losing the
-- information, which is the mistake m304's header records the six-value taxonomy
-- making with photographers and landscapers.
--
-- ── WHY `surveyor` IS ON THE STATE-LICENSED LIST, AND `inspector` STILL IS NOT ──
--
-- m551 set the test and m554 applied it: a trade belongs on
-- vendor_trade_requires_state_license only when there is NO STATE in which an
-- unlicensed practitioner is legitimate — because a gate that is wrong in one
-- direction is not safer than no gate, it is a gate that gets switched off.
--
--   inspector   FAILS the test. Home-inspector licensure is not universal; a
--               hard refusal would refuse legitimate inspectors everywhere that
--               does not license them. Still off the list.
--   appraiser   PASSES (m554). Title XI of FIRREA requires a state-certified or
--               state-licensed appraiser for any federally related transaction.
--   surveyor    PASSES, and for the same structural reason rather than by
--               analogy. Professional land surveying is a licensed practice in
--               every US state: each state runs a board of licensure for
--               professional engineers and land surveyors, the credential is
--               reached through the NCEES FS/PS examination sequence, and
--               offering land-surveying services without that licence is
--               prohibited practice — there is no state that leaves surveying
--               unregulated the way a dozen leave home inspection unregulated.
--               A surveyor's seal is also what makes the plat recordable, so an
--               unlicensed survey is not merely a lesser service; it is one the
--               county will not accept.
--
-- CONSEQUENCE, stated so it is not a surprise (the same one m554 spelled out for
-- appraisers): a surveyor bench row linked to a marketplace profile is now
-- UNBOOKABLE in a state until an active coverage row with a current licence
-- exists for (that company, 'surveyor', that state) — enforced by
-- trg_vendor_bookings_service_area on vendor_bookings, not merely in application
-- code. A LOCAL bench row with no platform identity still answers
-- 'local_bench_row', but only once a current licence sits in
-- vendors.compliance_credentials -> 'license'; with none it answers
-- 'licence_missing' and the booking is refused. Zero live rows are affected
-- (vendor_service_areas=0, vendor_bookings=0), so nothing goes dark today.
--
-- ── CLAUDE.md §5 DOES **NOT** EXTEND TO SURVEYORS, AND THAT IS A FINDING ─────
--
-- m554's real work was not the widening — it was noticing that benching
-- appraisers opened NEW model-authored routes to one, and that §5 forbids them.
-- The honest question here is whether a fortieth trade drags the same
-- obligation along. IT DOES NOT, and the reason is that §5 names appraisers
-- specifically because APPRAISER INDEPENDENCE is a named doctrine (USPAP;
-- Dodd-Frank §1472) about not influencing an OPINION OF VALUE. A land surveyor
-- measures a boundary; there is no opinion to influence and no independence
-- doctrine to breach. Nothing about a drafted message to a surveyor is a
-- compliance act.
--
-- SO THE GATE MUST NOT WIDEN EITHER, and it was checked rather than assumed:
--   · lib/vendors/appraiser-independence.ts :: isAppraiserTrade is EXACT
--     equality on VENDOR_CATEGORY_APPRAISER through toVendorCategory. Once
--     `surveyor` is a member, toVendorCategory('surveyor') returns 'surveyor',
--     which is not 'appraiser' — so coordinateVendors keeps working for
--     surveyors and keeps refusing for appraisers. No over-catch.
--   · the free-text service-label refusal is /\bapprais(al|als|er|ers|e|ed|ing)\b/i.
--     "survey", "surveyor" and "boundary survey" do not match it. No over-catch.
-- A gate that quietly grew to cover a trade the rule never named would be the
-- over-wide gate m551 warned gets switched off.
--
-- ── RESPA ALREADY KNEW ABOUT SURVEYORS, WHICH IS WHY NOTHING MOVES THERE ─────
--
-- lib/compliance/vendor-respa.ts has carried "surveyor"/"survey" in
-- SETTLEMENT_TOKENS since it was written — a survey IS a settlement service
-- under Regulation X, and the module's own header names surveyors in its first
-- sentence. Before this migration that code was reachable only through the
-- free-text `referral_partners` spelling, because `vendors.category` could not
-- hold the word. After it, isRespaRegulatedCategory('surveyor') is true for
-- BENCH rows too, so a preferred surveyor shown to a client now carries the
-- RESPA disclosure and a referral fee against one is structurally blocked at
-- createPartner. That is a gate switching ON as a consequence of the widening,
-- and it is the correct direction — it needed no change here because the
-- classifier was already written to the settlement-service list rather than to
-- the CHECK.
--
-- ── THE §6 DEFECT IS STILL THAT THE TWINS ARE DUPLICATED AT ALL ─────────────
--
-- Unchanged and still UNRESOLVED. m554's header sets out the clean derivation (a
-- single-column public.vendor_trade_categories table with both columns moved
-- from CHECK to FOREIGN KEY, which Postgres permits where it forbids a
-- cross-table CHECK) together with the two honest costs: the generated cache
-- scripts/check-vocabularies.ts is built from pg_constraint CHECK definitions
-- and would go BLIND to an FK vocabulary unless scripts/schema-cache-builders.ts
-- learns to read single-column reference tables, and two further vocabularies
-- would still sit outside it. THIS MIGRATION IS THE THIRD TIME THE SAME LIST HAS
-- BEEN REWRITTEN BY HAND (m304, m554, m562), which is the strongest evidence yet
-- that the derivation is worth doing. Not undertaken here — a fortieth value is
-- not the change under which to re-plumb the vocabulary — but the count of
-- hand-rewrites is now recorded so the next lane can weigh it.
--
-- Note also, unchanged: an appraiser and now a surveyor still CANNOT be the
-- `assignment_type` of a vendor_assignment. That column carries a separate
-- TEN-value CHECK (inspector, lender, title, stager, photographer, cleaner,
-- contractor, mover, insurance, other) and is deliberately out of scope here,
-- exactly as it was for m554.
--
-- APPLICATION STATUS: APPLIED 2026-08-25 to project hrvaqgvukzxfskkcrwbt, with
--   before/after two-sided controls whose fixtures were run inside DO blocks
--   ending in RAISE and therefore rolled back; the one INSERT taken outside a
--   DO block was deleted with .select() and its returned row COUNTED (CLAUDE.md
--   §3 — a DELETE that matches nothing also resolves), and the live counts were
--   proved back to vendors=1, vendor_service_areas=0,
--   vendor_marketplace_profiles=0, contacts=4, brokerages=2, leads=0,
--   ai_tool_usage=23. No assertion anywhere is pinned to the words of this line
--   (CLAUDE.md §2 — do not pin an assertion to a waypoint): every guard asks the
--   DATABASE, or the generated vocabulary cache, whether the value is admitted.
--
--   SCHEMA CACHES (CLAUDE.md §3): this widens two CHECKs, so
--   scripts/check-vocabularies.ts drifted the moment it was applied and was
--   REGENERATED by `npm run schema:regen:vocabularies` — piped from the live
--   database, never hand-edited. No table is added or dropped, so
--   scripts/live-tables.ts and scripts/schema-fk-map.ts are untouched by design.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE BENCH VOCABULARY. `vendors.category` — what a tenant's bench row may
--    call the company it hired. 39 -> 40.
--
--    'surveyor' is appended at the END, beside 'appraiser', for the reason m554
--    recorded: the ordering of a CHECK's array is not semantic, but
--    scripts/check-vocabularies.ts is GENERATED from pg_get_constraintdef and a
--    reordering would rewrite that cache's diff for no behavioural reason. The
--    GROUPED, human-facing ordering lives where it can be read —
--    lib/kernel/vendor-categories.ts :: VENDOR_CATEGORY_GROUPS — and that is
--    where 'surveyor' sits with the transaction trades.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.vendors
  drop constraint if exists vendors_category_check;
alter table public.vendors
  add constraint vendors_category_check
  check (category = any (array[
    'inspector','lender','title','attorney','contractor','stager','photographer',
    'cleaner','mover','insurance','handyman','property_management','landscaping',
    'pest_control','pool_service','hvac','plumber','electrician','roofer','painter',
    'flooring','solar','security','smart_home','appliance_repair','window_treatment',
    'garage_door','refinance_lender','home_warranty','tax_pro','financial_advisor',
    'interior_design','organizer','estate_sale','videographer','drone_pilot',
    '3d_tour','other','appraiser','surveyor'
  ]));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE COVERAGE VOCABULARY. `vendor_service_areas.trade_category` — the trade
--    a per-(company, state) licence is filed AGAINST. The SAME 40 values, in the
--    SAME order, because the guard asserts the two lists are identical and a
--    difference between them is the defect the guard exists to catch.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.vendor_service_areas
  drop constraint if exists vendor_service_areas_trade_category_check;
alter table public.vendor_service_areas
  add constraint vendor_service_areas_trade_category_check
  check (trade_category = any (array[
    'inspector','lender','title','attorney','contractor','stager','photographer',
    'cleaner','mover','insurance','handyman','property_management','landscaping',
    'pest_control','pool_service','hvac','plumber','electrician','roofer','painter',
    'flooring','solar','security','smart_home','appliance_repair','window_treatment',
    'garage_door','refinance_lender','home_warranty','tax_pro','financial_advisor',
    'interior_design','organizer','estate_sale','videographer','drone_pilot',
    '3d_tour','other','appraiser','surveyor'
  ]));

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. THE LICENCE GATE. Six trades -> seven. Mirrored EXACTLY by
--    lib/vendors/vendor-service-area.ts :: STATE_LICENSED_VENDOR_CATEGORIES;
--    scripts/vendor-service-area-simulator.ts and
--    scripts/appraiser-bench-simulator.ts both assert the two lists are
--    identical, and both find this definition by taking the HIGHEST-numbered
--    migration that states it (scripts/vendor-trade-vocab-source.ts ::
--    latestMigrationDefining) rather than by naming a file — so redefining the
--    function here moves both guards onto m562 automatically, which is the
--    waypoint bug those guards were rewritten to avoid.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.vendor_trade_requires_state_license(p_trade text)
returns boolean
language sql
immutable
parallel safe
set search_path to 'public', 'pg_temp'
as $fn$
  select coalesce(p_trade, '') = any (array[
    'lender', 'refinance_lender', 'title', 'attorney', 'insurance', 'appraiser',
    'surveyor'
  ]);
$fn$;

comment on function public.vendor_trade_requires_state_license(text) is
  'Trades whose practitioners are STATE-LICENSED, so coverage in a state is only '
  'real when a current licence backs it (m551; appraiser added m554; surveyor '
  'added m562 on the owner ruling "surveyor is a vendor category"). THE TEST FOR '
  'MEMBERSHIP IS UNIVERSALITY, NOT IMPORTANCE: a trade belongs here only when '
  'there is no state in which an unlicensed practitioner is legitimate, because '
  'a gate that is wrong in one direction gets switched off. Title XI of FIRREA '
  'makes state certification mandatory for federally related appraisals, and '
  'every state licenses professional land surveyors through a board of licensure '
  '(NCEES FS/PS) — a surveyor''s seal is what makes a plat recordable. '
  '`inspector` is deliberately EXCLUDED for failing that same test: home-'
  'inspector licensure is not universal. Mirrored EXACTLY by '
  'lib/vendors/vendor-service-area.ts :: STATE_LICENSED_VENDOR_CATEGORIES; the '
  'guard asserts the two lists are identical.';

comment on column public.vendors.category is
  'The ONE vendor trade taxonomy (m304 widened it to 38; m554 added ''appraiser'' '
  'for 39; m562 added ''surveyor'' for 40). Spelled identically by '
  'vendor_service_areas.trade_category and by lib/kernel/vendor-categories.ts :: '
  'VENDOR_CATEGORIES. NOT the same vocabulary as '
  'vendor_assignments.assignment_type (a ten-value subset, which carries NEITHER '
  'appraiser NOR surveyor) or vendor_marketplace_profiles.category '
  '(api/service/tool/integration — a marketplace-integration vocabulary, not a '
  'trade). APPRAISER CARRIES A RULE THE OTHER 39 DO NOT: CLAUDE.md §5 — anything '
  'reaching a licensed appraiser must not be model-authored. That rule and its '
  'route inventory live at lib/vendors/appraiser-independence.ts, and it does NOT '
  'extend to surveyor: appraiser independence (USPAP, Dodd-Frank §1472) protects '
  'an OPINION OF VALUE, and a boundary measurement is not one. '
  'm561: "SERVICE TYPE" IS NOT A SECOND VOCABULARY — it was this one, spelled as '
  'the noun of the job (photography/staging/inspection/appraisal/cleaning/repairs/'
  'moving) instead of the noun of the person, and joined with ILIKE ''%x%''; eight '
  'of those ten spellings matched NOTHING here. Retired spellings normalise '
  'through lib/kernel/vendor-categories.ts :: toVendorCategory / '
  'benchCategoryFilter, which is the ONLY supported way to turn a caller''s '
  '"service type" into a filter on this column. NEVER filter this column with '
  'ILIKE ''%x%'': the vocabulary is closed AND self-overlapping — ''%lender%'' also '
  'matches ''refinance_lender'' — so a substring both misses and over-matches. '
  'ESCROW IS NOT A MEMBER AND IS NOT MISSING: it is a spelling of ''title'', '
  'because transaction_title_escrow holds both officers on one row, '
  'deposits.escrow_company has no vendors FK, vendor_assignments.assignment_type '
  'carries ''title'' and never ''escrow'', and lib/compliance/vendor-respa.ts '
  'already folds it into the title settlement-service bucket. SURVEYOR WAS THE '
  'OPPOSITE CASE and m561 recorded it as unresolved rather than folding it into '
  '''other''; m562 resolved it on the owner ruling, so it is now a member in its '
  'own right and is STATE-LICENSED — see '
  'public.vendor_trade_requires_state_license.';

comment on column public.vendor_service_areas.trade_category is
  'The trade a per-(company, state) licence is filed AGAINST. THE SAME vocabulary '
  'as vendors.category, value for value and in the same order — a cross-table '
  'CHECK is not expressible in Postgres, so the list is written out twice and '
  'scripts/vendor-service-area-simulator.ts asserts the two are identical. THEY '
  'MOVE TOGETHER OR NOT AT ALL (m551, m554, m562): widening one alone gives a '
  'vendor a trade the coverage table cannot express, so no licence could ever be '
  'filed and vendor_bookable_in_state answers ''vendor_coverage_unknown'' forever. '
  'm561 moved NEITHER and explained why ''escrow'' is a spelling of ''title'' '
  'rather than a fortieth value. m562 moved BOTH, to 40, adding ''surveyor'' on '
  'the owner ruling — and put it behind the licence gate, so a surveyor is '
  'unbookable in a state where the company holds no current licence.';

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION (the live two-sided controls run in
-- scripts/appraiser-bench-simulator.ts and scripts/vendor-service-area-simulator.ts):
--
--   -- POSITIVE: the widened vocabularies admit the new value
--   insert into public.vendors(name, category, brokerage_id) values (…, 'surveyor', …);
--     -- expected: accepted
--
--   -- POSITIVE CONTROL ON THE POSITIVE: the CHECK is WIDENED, not DROPPED
--   insert into public.vendors(name, category, brokerage_id) values (…, 'not_a_real_trade', …);
--     -- expected: 23514, still refused
--   insert into public.vendors(name, category, brokerage_id) values (…, 'escrow', …);
--     -- expected: 23514, still refused — m561's ruling survives m562
--
--   -- the two twins still agree, DERIVED rather than typed:
--   with defs as (
--     select conname,
--            (select array_agg(m[1] order by ord)
--               from regexp_matches(pg_get_constraintdef(oid), '''([a-z0-9_]+)''::text', 'g')
--                 with ordinality as t(m, ord)) as vocab
--     from pg_constraint
--     where conname in ('vendors_category_check',
--                       'vendor_service_areas_trade_category_check'))
--   select conname, cardinality(vocab),          -- expected 40, 40
--          'surveyor'  = any(vocab),             -- expected true
--          'appraiser' = any(vocab),             -- expected true
--          'escrow'    = any(vocab)              -- expected false
--   from defs;
--
--   -- the licence gate now covers the trade, and still does not cover the one
--   -- trade that fails the universality test:
--   select public.vendor_trade_requires_state_license('surveyor');   -- expected true
--   select public.vendor_trade_requires_state_license('appraiser');  -- expected true
--   select public.vendor_trade_requires_state_license('inspector');  -- expected false
-- ─────────────────────────────────────────────────────────────────────────────
