-- m554 — AN APPRAISER IS ANOTHER VENDOR TYPE AND IS STATE LICENSED
-- =============================================================================
--
-- OWNER RULING, verbatim:
--
--   "an appraiser can be another vendor type and is state licensed."
--
-- m551 named this exact gap and declined to close it on its own initiative. Its
-- own words, at
-- supabase/migrations/m551-a-vendor-crossing-state-lines-had-nowhere-to-say-where-it-is-licensed.sql
-- section 4, and again at lib/vendors/vendor-service-area.ts ::
-- STATE_LICENSED_VENDOR_CATEGORIES:
--
--   "APPRAISER IS MISSING FROM THE VOCABULARY ITSELF and that is a finding, not
--    an omission here. […] Adding one means widening a live CHECK and
--    regenerating the vocabulary cache, which is not this lane's to do."
--
-- This migration is that widening, and the owner ruling is the authority for it.
--
-- ── WHAT WAS MEASURED LIVE BEFORE WRITING THIS (2026-08-25) ──────────────────
--
--   · public.vendors_category_check                       38 values, no 'appraiser'
--   · public.vendor_service_areas_trade_category_check    38 values, no 'appraiser'
--     …and the two lists are BYTE-IDENTICAL, in the same order.
--   · public.vendor_trade_requires_state_license('appraiser') = false
--                                          ('title')          = true
--                                          ('stager')         = false
--   · public.vendor_directory DOES NOT EXIST (retired at m355). The third
--     spelling m304's header warns about is already gone; do not resurrect it.
--
--   TWO-SIDED CONTROL, run live before applying, inside a DO block that ends in
--   RAISE so nothing was left behind:
--     vendors.category            appraiser=REFUSED(23514)  invented=REFUSED(23514)
--     vsa.trade_category          appraiser=REFUSED(23514)  invented=REFUSED(23514)
--   The invented value is the POSITIVE CONTROL (CLAUDE.md section 2): after this
--   migration 'appraiser' must be ADMITTED **and 'not_a_real_trade' must still be
--   REFUSED**, so a widened vocabulary is distinguishable from a dropped CHECK.
--
--   BLAST RADIUS, measured before applying: vendors=1, vendor_marketplace_profiles=0,
--   vendor_service_areas=0, vendor_bookings=0, subscriber_service_areas=0,
--   listings=3, brokerages=2. Nothing live holds either column, so widening the
--   two CHECKs cannot invalidate an existing row and the licence gate takes no
--   existing booking dark.
--
-- ── WHY BOTH VOCABULARIES MOVE IN ONE MIGRATION ──────────────────────────────
--
-- They are TWO SPELLINGS OF ONE TAXONOMY (CLAUDE.md section 6) and m551 already
-- says so: a CHECK cannot reference another table, so the 38 values were written
-- out twice and scripts/vendor-service-area-simulator.ts asserts the two lists
-- are IDENTICAL. Widening only one of them would give a vendor a trade the bench
-- can express but the coverage table cannot (so no licence could ever be filed
-- for it, and vendor_bookable_in_state would answer 'vendor_coverage_unknown'
-- forever), or a coverage row for a trade no bench row can hold. Both, or
-- neither.
--
-- ── THE section 6 DEFECT IS THAT THEY ARE DUPLICATED AT ALL — RECORDED, NOT FIXED ──
--
-- This lane was told to record it rather than undertake it, and it is real: the
-- SAME 38 (now 39) literals exist in three places — vendors_category_check,
-- vendor_service_areas_trade_category_check, and
-- lib/kernel/vendor-categories.ts :: VENDOR_CATEGORIES. There IS a clean way to
-- derive one from the other, and it is worth writing down so the next lane does
-- not have to re-derive it:
--
--   A single-column table public.vendor_trade_categories(category text primary key),
--   seeded from the current list, with BOTH columns changed from a CHECK to a
--   FOREIGN KEY onto it. Postgres permits an FK where it forbids a cross-table
--   CHECK, so the vocabulary would then have exactly ONE definition in the
--   database, adding a trade would be one INSERT instead of two DDL rewrites, and
--   the pair could not drift. Costs, honestly: (a) the generated vocabulary cache
--   scripts/check-vocabularies.ts is built from pg_constraint CHECK definitions,
--   so an FK vocabulary would become INVISIBLE to it and to
--   test:check-vocabulary unless scripts/schema-cache-builders.ts learns to read
--   single-column FK reference tables too; (b) two other live vocabularies would
--   still be outside it — vendor_assignments.assignment_type (a TEN-value subset:
--   inspector, lender, title, stager, photographer, cleaner, contractor, mover,
--   insurance, other — which is why an appraiser cannot be the *assignment_type*
--   of a vendor_assignment even after this migration) and
--   vendor_marketplace_profiles.category (api/service/tool/integration, a
--   marketplace-integration vocabulary and NOT a trade). A derivation that leaves
--   two of four spellings behind is half a fix. UNRESOLVED, and named here so it
--   is not rediscovered as a surprise.
--
-- ── WHY APPRAISER IS ON THE STATE-LICENSED LIST AND INSPECTOR IS NOT ─────────
--
-- m551 excluded `inspector` because home-inspector licensure is NOT universal
-- across the states, so a hard refusal would refuse legitimate inspectors
-- everywhere that does not license them. Appraisers are the opposite case and
-- the distinction is not a judgement call: Title XI of FIRREA requires every
-- appraisal for a federally related transaction to be performed by a
-- state-certified or state-licensed appraiser, and every state runs an appraiser
-- licensing board to issue that credential. There is no state in which an
-- unlicensed appraiser is legitimate, so the gate is not wrong in either
-- direction — which was m551's stated test for putting a trade on this list.
--
-- ── CLAUDE.md section 5 IS THE LOAD-BEARING PART OF THIS CHANGE ──────────────
--
--   "Anything reaching a licensed appraiser must not be model-authored."
--
-- Before this migration an appraiser could only be reached through
-- lib/kernel/appraiser-packet.ts, which enforces that rule by construction (it
-- sources comparables from lib/cma/comp-provider rather than from an AI web
-- search, and deliberately does NOT carry our own value opinion to the
-- appraiser). Making `appraiser` a bench category opens NEW routes to one:
-- vendor messaging, vendor communications, vendor jobs and the vendor portal.
-- Every one of those was walked before this was applied. The audit and the gate
-- live in code, next to the surfaces, not in this file:
--
--   lib/vendors/appraiser-independence.ts   the ONE rule, the route inventory,
--                                           and the pure verdict function
--   app/actions/ai-vendor-management.ts     coordinateVendors — the one live
--                                           violation found, now gated
--   scripts/appraiser-bench-simulator.ts    two-sided proof, in `npm run guard`
--
-- The one violation found was `coordinateVendors`, whose model writes
-- `communicationPlan.vendorMessages[]` — messages ADDRESSED TO a named vendor,
-- rendered with a Copy button in
-- app/components/dashboard/listings/lifecycle/vendor-coordination-panel.tsx for
-- an agent to send. A model writing to an appraiser about a listing is precisely
-- what appraiser-independence rules exist to stop, so that action now REFUSES
-- before it spends the model call. The deterministic vendor emails
-- (app/actions/vendor-marketplace.ts and lib/communications/vendor-communications.tsx)
-- were checked and carry no model output; they are unchanged.
--
-- APPLICATION STATUS: APPLIED 2026-08-25 to project hrvaqgvukzxfskkcrwbt, with
--   before/after two-sided controls and their fixtures removed (counts returned
--   to vendors=1, vendor_service_areas=0, vendor_marketplace_profiles=0,
--   vendor_bookings=0). No assertion anywhere is pinned to the words of this line
--   (CLAUDE.md section 2 — do not pin an assertion to a waypoint):
--   scripts/appraiser-bench-simulator.ts asks the DATABASE whether the value is
--   admitted and whether the gate refuses, and reports the pre-migration shape
--   honestly where it is not.
--
--   SCHEMA CACHES (CLAUDE.md section 3): this widens two CHECKs, so
--   scripts/check-vocabularies.ts drifted the moment it was applied and was
--   REGENERATED by `npm run schema:regen:vocabularies` — piped from the live
--   database, never hand-edited. No table is added or dropped, so
--   scripts/live-tables.ts and scripts/schema-fk-map.ts are untouched by design.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE BENCH VOCABULARY. `vendors.category` — what a tenant's bench row may
--    call the company it hired. 38 -> 39.
--
--    'appraiser' is appended at the END rather than inserted beside 'inspector',
--    even though that is where it belongs conceptually. The ordering of a CHECK's
--    array is not semantic, but scripts/check-vocabularies.ts is GENERATED from
--    pg_get_constraintdef and a reordering would rewrite that cache's diff for no
--    behavioural reason. The GROUPED, human-facing ordering lives where it can
--    be read — lib/kernel/vendor-categories.ts :: VENDOR_CATEGORY_GROUPS — and
--    that is where 'appraiser' sits next to 'inspector'.
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
    '3d_tour','other','appraiser'
  ]));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE COVERAGE VOCABULARY. `vendor_service_areas.trade_category` — the trade
--    a per-(company, state) licence is filed AGAINST. The SAME 39 values, in the
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
    '3d_tour','other','appraiser'
  ]));

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. THE LICENCE GATE. m551's own comment names this function as "the ONE place
--    that would change" when appraisers were wired in. It is.
--
--    Consequence, stated so it is not a surprise: an appraiser bench row linked
--    to a marketplace profile is now UNBOOKABLE in a state until an active
--    coverage row with a current licence exists for (that company, 'appraiser',
--    that state) — enforced by trg_vendor_bookings_service_area on
--    vendor_bookings, not merely by application code. A LOCAL bench row (no
--    platform identity) still answers 'local_bench_row', but only once a current
--    licence record sits in vendors.compliance_credentials -> 'license'; with
--    none it answers 'licence_missing' and the booking is refused. That is the
--    intended reading of "is state licensed".
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.vendor_trade_requires_state_license(p_trade text)
returns boolean
language sql
immutable
parallel safe
set search_path to 'public', 'pg_temp'
as $fn$
  select coalesce(p_trade, '') = any (array[
    'lender', 'refinance_lender', 'title', 'attorney', 'insurance', 'appraiser'
  ]);
$fn$;

comment on function public.vendor_trade_requires_state_license(text) is
  'Trades whose practitioners are STATE-LICENSED, so coverage in a state is only '
  'real when a current licence backs it (m551; appraiser added m554 on the owner '
  'ruling "an appraiser can be another vendor type and is state licensed" — Title '
  'XI of FIRREA makes state certification mandatory for federally related '
  'appraisals, so unlike inspector there is no state in which an unlicensed '
  'appraiser is legitimate). Mirrored EXACTLY by lib/vendors/vendor-service-area.ts '
  ':: STATE_LICENSED_VENDOR_CATEGORIES; the guard asserts the two lists are identical.';

comment on column public.vendors.category is
  'The ONE vendor trade taxonomy (m304 widened it to 38; m554 added ''appraiser'' '
  'for 39). Spelled identically by vendor_service_areas.trade_category and by '
  'lib/kernel/vendor-categories.ts :: VENDOR_CATEGORIES. NOT the same vocabulary '
  'as vendor_assignments.assignment_type (a ten-value subset) or '
  'vendor_marketplace_profiles.category (api/service/tool/integration — a '
  'marketplace-integration vocabulary, not a trade). APPRAISER CARRIES A RULE THE '
  'other 38 do not: CLAUDE.md section 5 — anything reaching a licensed appraiser '
  'must not be model-authored. The rule and its route inventory live at '
  'lib/vendors/appraiser-independence.ts.';

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION (the live two-sided controls run in
-- scripts/appraiser-bench-simulator.ts, `npm run test:appraiser-bench`):
--
--   -- POSITIVE: the widened vocabularies admit the new value
--   insert into public.vendors(name, category, brokerage_id) values (…, 'appraiser', …);
--     -- expected: accepted
--
--   -- POSITIVE CONTROL ON THE POSITIVE: the CHECK is WIDENED, not DROPPED
--   insert into public.vendors(name, category, brokerage_id) values (…, 'not_a_real_trade', …);
--     -- expected: 23514, still refused
--
--   -- the licence gate now covers the trade, and still does not cover an
--   -- unlicensed one
--   select public.vendor_trade_requires_state_license('appraiser');  -- expected true
--   select public.vendor_trade_requires_state_license('inspector');  -- expected false
--
--   -- THE GATE ACTUALLY REFUSES: a marketplace appraiser with coverage in AZ but
--   -- NO licence cannot be booked onto an AZ listing —
--   -- trg_vendor_bookings_service_area raises 23514 with reason licence_missing.
--   -- Give the coverage row a current licence and the same INSERT succeeds.
-- ─────────────────────────────────────────────────────────────────────────────
