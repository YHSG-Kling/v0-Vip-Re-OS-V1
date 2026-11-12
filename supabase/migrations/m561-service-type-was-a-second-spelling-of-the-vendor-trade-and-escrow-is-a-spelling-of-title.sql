-- m561 — "SERVICE TYPE" WAS A SECOND SPELLING OF THE VENDOR TRADE, AND `escrow`
--         IS A SPELLING OF `title`
-- =============================================================================
--
-- OWNER RULING, verbatim:
--
--   "consolodate service types"
--
-- ── THIS MIGRATION CHANGES NO VOCABULARY. THAT IS THE FINDING. ───────────────
--
-- m554's header predicted the next lane would arrive here wanting to widen
-- something. It should not, and the reason is worth stating in the database
-- rather than only in a lane report: the second taxonomy was never a set of
-- trades the platform was missing. It was the SAME trades, spelled as the noun
-- of the JOB where the column holds the noun of the PERSON, joined to the column
-- with a SUBSTRING MATCH. There was nothing to add — only three duplicate lists
-- to delete and one loose join to make exact.
--
-- So this migration is COMMENTS ONLY. No CHECK is dropped, widened or narrowed;
-- vendors_category_check and vendor_service_areas_trade_category_check are the
-- SAME 39 values m554 left them at, and no vocabulary cache needs regenerating
-- (CLAUDE.md §3 — the cache is built from pg_constraint CHECK defs, and no CHECK
-- def moves here). What it does do is record two rulings at the source of truth,
-- where the next lane will read them off `\d+` instead of rediscovering them.
--
-- ── WHAT WAS MEASURED LIVE BEFORE WRITING THIS (2026-08-25, hrvaqgvukzxfskkcrwbt) ──
--
-- 1. THE EIGHT-OF-TEN MISS. `app/actions/ai-vendor-management.ts ::
--    getVendorRecommendations` typed its `serviceType` as its own ten-value
--    union and filtered `.ilike("category", '%${serviceType}%')`. Joined against
--    the live 39-value vendors_category_check:
--
--      serviceType    ILIKE '%…%' matched
--      photography    (none)          ← photographer
--      staging        (none)          ← stager
--      inspection     (none)          ← inspector
--      appraisal      (none)          ← appraiser
--      cleaning       (none)          ← cleaner
--      repairs        (none)          ← contractor
--      moving         (none)          ← mover
--      escrow         (none)          ← no member at all
--      landscaping    landscaping     ✓
--      title          title           ✓
--
--    EIGHT OF TEN RETURNED AN EMPTY BENCH — and the action then spent a gpt-4o
--    call recommending three vendors out of zero. `generateObject` in
--    lib/ai/generate.ts calls no logAIUsage (its own header says so), so that
--    spend did not even reach `ai_tool_usage`; it was an under-count in the
--    ledger that feeds meter_readings.ai_tokens and the overage projection
--    (CLAUDE.md §5). The action now refuses before the read when the trade
--    cannot be placed, and before the model call when the bench comes back
--    empty or refused.
--
-- 2. THE OVER-MATCH, WHICH IS NOT HYPOTHETICAL. `%lender%` also matches
--    `refinance_lender`. Both are members of the CHECK on purpose. So every
--    lender search, availability check, best-match and COST COMPARISON in
--    app/actions/vendor-marketplace.ts silently mixed refinance shops into a
--    purchase-lender answer. A LIKE over a closed vocabulary is wrong in both
--    directions at once; all six bench reads are `.eq` now.
--
-- 3. TWO-SIDED CONTROL, run live before writing this, inside a DO block ending
--    in RAISE so nothing was left behind (the m554 pattern):
--
--      insert vendors.category = 'title'             → ADMITTED
--      insert vendors.category = 'appraiser'         → ADMITTED   (m554 in force)
--      insert vendors.category = 'escrow'            → REFUSED 23514
--      insert vendors.category = 'not_a_real_trade'  → REFUSED 23514
--
--    The invented value is the POSITIVE CONTROL: `escrow` being refused only
--    means something if a CHECK is still there to refuse it. And derived from
--    pg_get_constraintdef rather than from any literal typed here, BOTH twins
--    still carry 39 values and agree exactly — title/appraiser/landscaping
--    ADMITTED, escrow/surveyor/not_a_real_trade REFUSED.
--
--    BLAST RADIUS, measured: vendors=1, vendor_service_areas=0,
--    vendor_marketplace_profiles=0, vendor_bookings=0, brokerages=2 — before and
--    after, with the probes rolled back.
--
-- ── RULING 1: `escrow` IS RETIRED AS A SPELLING OF `title`, NOT ADDED ────────
--
-- It was the one value of the ten with no possible member, so the question is
-- fair: m554 widened the CHECK for `appraiser`, why not for this? Because the
-- two cases are opposite, and the live schema — not a judgement call — says so.
-- `appraiser` named a distinct state-licensed profession with NO home in the
-- taxonomy. `escrow` already has one, and four independent writers already treat
-- it that way:
--
--   · public.transaction_title_escrow is ONE table holding title_officer_name /
--     _email / _phone AND escrow_officer_name / _email / _phone for the same
--     counterparty on a deal. The database already models escrow as a ROLE AT
--     the title company, not as a company of its own.
--   · public.deposits.escrow_company is free text with no FK to vendors — no
--     bench row was ever intended to be the escrow holder.
--   · lib/compliance/vendor-respa.ts folds "escrow" and "escrowofficer" into the
--     TITLE settlement-service bucket for RESPA matching.
--   · public.vendor_assignments.assignment_type — the ten-value deal-ledger
--     subset — carries `title` and has never carried `escrow`.
--   · lib/kernel/vendor-categories.ts :: toVendorCategory ALREADY mapped
--     'escrow' → 'title' before this lane touched it.
--
-- Widening the CHECK would have created the §6 defect rather than closing it: a
-- bench could then hold an `escrow` company and a `title` company that are the
-- same firm, and no scorer could match them.
--
-- ── RULING 2: `surveyor` IS UNRESOLVED, AND IS NOT FOLDED ────────────────────
--
-- app/components/transactions/VendorBookingSection.tsx offered `surveyor`. It is
-- not a member of either twin (verified live, REFUSED by both) and it is not a
-- spelling of any of the 39 — a land surveyor is its own licensed trade. It is
-- deliberately NOT mapped to `other`: filing a surveyor under the catch-all
-- would make the vocabulary look complete while losing the information, which is
-- the mistake m304's header records the six-value taxonomy making with
-- photographers and landscapers. toVendorCategory('surveyor') returns null and
-- the caller refuses in words. Whether to widen both twins for it the way m554
-- widened them for `appraiser` is an OWNER call, and it is recorded here rather
-- than guessed. UNRESOLVED.
--
-- ── RULING 3: vendor_bookings.service_type STAYS UN-CHECKED, DELIBERATELY ────
--
-- It is the column the retired pickers wrote into, so the obvious next move is a
-- CHECK built from the trade vocabulary. IT WOULD REFUSE LIVE, CORRECT WRITERS —
-- and 23514 refuses the ENTIRE ROW, not the column. The column legitimately
-- carries machine provenance outside the trade taxonomy:
--
--   'insurance_quote'   app/actions/transaction-inspections.ts:327
--                       app/actions/transaction-hazard-insurance.ts:535
--                       …and READ BACK by service_type at hazard-insurance:178
--   'crm_sync'          app/actions/crm-connect.ts:108, read back at :237
--   'personal_email'    app/api/integrations/oauth/[provider]/route.ts:422
--   package service types ('professional_photos', 'drone_video', …)
--                       app/actions/marketing-package-automation.ts:202
--
-- This is the same ruling `contacts.source` got (see lib/kernel/manager-registry.ts
-- :: vendor_tenancy_lead_source): the gate belongs at the agent-facing picker,
-- which now cannot express a value outside the CHECK, not on a column that has
-- other honest writers.
--
-- ── WHAT CHANGED IN CODE (this migration is the record, not the mechanism) ───
--
--   SURVIVOR   lib/kernel/vendor-categories.ts — already the module that
--              declares itself "THE ONE vendors.category vocabulary", and the
--              only one of the four that matched the live CHECK element for
--              element. §1.1: the retired spellings were MERGED ONTO it first
--              (VENDOR_CATEGORY_SYNONYMS) and benchCategoryFilter added, THEN
--              the duplicates were deleted.
--
--   DELETED, each with a tombstone naming the survivor at file:line —
--     lib/marketing/vendor-ranking.ts            a 38-value copy that had
--                                                DRIFTED: it missed `appraiser`
--                                                from m554 onward, so
--                                                isVendorCategory('appraiser')
--                                                answered false there and true
--                                                in the survivor.
--     .../lifecycle/vendor-booking-button.tsx    an 11-value Title-Case picker —
--                                                the origin of the AI union.
--     app/components/transactions/VendorBookingSection.tsx
--                                                a 15-value picker; 13 members,
--                                                plus `escrow` and `surveyor`.
--     app/actions/vendor-marketplace.ts          getSuggestedVendorsByStage's
--                                                nine-literal stage map, of which
--                                                only three were members.
--   Both pickers now render app/components/vendors/vendor-category-select.tsx,
--   which is built from VENDOR_CATEGORY_GROUPS and cannot express a non-member.
--
--   PROOF      scripts/vendor-category-consolidation-simulator.ts
--              (`npm run test:vendor-categories`, already in `npm run guard`):
--              57 → 117 assertions, every absence assertion carrying a positive
--              control, every count derived from the live vocabulary cache
--              rather than pinned. Mutation-tested: eight re-introductions of
--              the defect each go RED, and the tree restores byte-identically.
--
-- APPLICATION STATUS: APPLIED 2026-08-25 to project hrvaqgvukzxfskkcrwbt.
--   Comments only — no constraint, table, column, index or function is created,
--   altered or dropped, so there is no rollback risk and no schema cache to
--   regenerate. The two-sided controls above were run before and after and are
--   UNCHANGED, which is the point: this migration must be indistinguishable from
--   a no-op to every guard that measures the vocabulary. No assertion anywhere
--   is pinned to the words of this line, or to any text below (CLAUDE.md §2 —
--   do not pin an assertion to a waypoint): the simulator asks the vocabulary
--   cache and the modules, never this file.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE TRADE VOCABULARY. Unchanged at 39 values. The comment m554 left is
--    extended with the escrow ruling and with the name of the ONE translator, so
--    a lane reading `\d+ public.vendors` learns that "service type" is not a
--    second vocabulary before it writes one.
-- ─────────────────────────────────────────────────────────────────────────────

comment on column public.vendors.category is
  'The ONE vendor trade taxonomy (m304 widened it to 38; m554 added ''appraiser'' '
  'for 39). Spelled identically by vendor_service_areas.trade_category and by '
  'lib/kernel/vendor-categories.ts :: VENDOR_CATEGORIES. NOT the same vocabulary '
  'as vendor_assignments.assignment_type (a ten-value subset) or '
  'vendor_marketplace_profiles.category (api/service/tool/integration — a '
  'marketplace-integration vocabulary, not a trade). APPRAISER CARRIES A RULE THE '
  'other 38 do not: CLAUDE.md section 5 — anything reaching a licensed appraiser '
  'must not be model-authored. The rule and its route inventory live at '
  'lib/vendors/appraiser-independence.ts. '
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
  'already folds it into the title settlement-service bucket. SURVEYOR is a real '
  'gap and is UNRESOLVED — it is deliberately not folded into ''other''.';

comment on column public.vendor_service_areas.trade_category is
  'The trade a per-(company, state) licence is filed AGAINST. THE SAME vocabulary '
  'as vendors.category, value for value and in the same order — a cross-table '
  'CHECK is not expressible in Postgres, so the list is written out twice and '
  'scripts/vendor-service-area-simulator.ts asserts the two are identical. THEY '
  'MOVE TOGETHER OR NOT AT ALL (m551, m554): widening one alone gives a vendor a '
  'trade the coverage table cannot express, so no licence could ever be filed and '
  'vendor_bookable_in_state answers ''vendor_coverage_unknown'' forever. m561 '
  'moved NEITHER — see the comment on vendors.category for why ''escrow'' is a '
  'spelling of ''title'' rather than a fortieth value, and why ''surveyor'' is '
  'recorded as unresolved instead of folded.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE BOOKING LEDGER'S service_type. Free text ON PURPOSE. This comment
--    exists so the next lane does not add the CHECK that looks obviously
--    missing and take four live writers dark with it (23514 refuses the whole
--    row, and two of those writers READ THE VALUE BACK to find their own rows).
-- ─────────────────────────────────────────────────────────────────────────────

comment on column public.vendor_bookings.service_type is
  'FREE TEXT, DELIBERATELY UN-CHECKED (m561). It looks like it should carry the '
  'vendors.category vocabulary, and the agent-facing pickers now do — but this '
  'column ALSO carries machine provenance that is not a trade and would be '
  'refused by such a CHECK: ''insurance_quote'' (app/actions/transaction-'
  'inspections.ts and transaction-hazard-insurance.ts, which READS IT BACK by '
  'equality to find its own rows), ''crm_sync'' (app/actions/crm-connect.ts, also '
  'read back), ''personal_email'' (app/api/integrations/oauth/[provider]/route.ts) '
  'and the marketing PACKAGE service types (''professional_photos'', '
  '''drone_video'', … — app/actions/marketing-package-automation.ts), which are a '
  'separate vocabulary joined to the trades by '
  'lib/marketing/vendor-ranking.ts :: vendorCategoryForService. 23514 refuses the '
  'ENTIRE ROW, so a CHECK built from the trade list would break all four. Same '
  'ruling as contacts.source — the gate belongs at the agent-facing picker (which '
  'since m561 cannot express a non-member), not on a column with other honest '
  'writers.';

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION — run before AND after; the answers must be IDENTICAL, because a
-- comments-only migration that moved a vocabulary would be the defect.
--
--   -- the two twins still carry the SAME 39 values (derived, not typed):
--   with defs as (
--     select conname,
--            (select array_agg(m[1] order by ord)
--               from regexp_matches(pg_get_constraintdef(oid), '''([a-z0-9_]+)''::text', 'g')
--                 with ordinality as t(m, ord)) as vocab
--     from pg_constraint
--     where conname in ('vendors_category_check',
--                       'vendor_service_areas_trade_category_check'))
--   select conname, cardinality(vocab),
--          'escrow' = any(vocab)   as admits_escrow,     -- expected false
--          'surveyor' = any(vocab) as admits_surveyor,   -- expected false
--          'appraiser' = any(vocab) as admits_appraiser  -- expected true
--   from defs;
--
--   -- and the CHECK still BITES (positive control on every refusal above):
--   insert into public.vendors(name, category, brokerage_id)
--     values (…, 'not_a_real_trade', …);   -- expected 23514, still refused
--   insert into public.vendors(name, category, brokerage_id)
--     values (…, 'title', …);              -- expected accepted
--
-- The code-side proof is scripts/vendor-category-consolidation-simulator.ts
-- (`npm run test:vendor-categories`), which derives every number from the
-- generated vocabulary cache rather than from this file.
-- ─────────────────────────────────────────────────────────────────────────────
