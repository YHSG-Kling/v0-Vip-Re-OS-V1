-- m527 — TIERS DIFFER BY SEAT COUNT, NOT BY FEATURE SET.
-- ─────────────────────────────────────────────────────────────────────────────
-- NOT APPLIED BY THIS LANE (CLAUDE.md §3). Data-only: no DDL, no CHECK, so no
-- vocabulary cache needs regenerating afterwards.
--
-- OWNER RULING, verbatim, and it is the whole file:
--
--   "brokerages can have teams and agents but that is the brokerage tier. when
--    we have the team and solo agent subscription tiers, those subscriptions
--    get the same level of features as brokerages."
--
-- Read with the seat ruling from the same thread — "team tier only has 5 seats
-- … agent tier subscription only has 2 seats … but these lower plans need to be
-- treated like mini brokerages" — the product model is: YOU PAY FOR SEATS,
-- EVERYONE GETS THE SAME PRODUCT. A solo agent IS a brokerage of one; a team IS
-- a brokerage of five.
--
-- m524 opened four flags (brokerage_dashboard, commission_reports,
-- compliance_reports, brokerage_settings) and DEFERRED seven more as "pricing
-- decisions this lane will not make silently". The owner has now made them.
--
-- ── PARITY IS TO **BROKERAGE**, NOT TO MULTI_LOCATION ────────────────────────
--
-- multi_location sits ABOVE brokerage. Anything brokerage itself does not have
-- is untouched by this file, and there are exactly two such rows — listed in
-- the NOT CHANGED section below.
--
-- ── SEATS AND CAPACITY ARE NOT FEATURES ──────────────────────────────────────
--
-- Untouched, deliberately, because the seat distinction IS the ruling:
--   • subscription_tiers.max_agents  (2 / 5 / null / null)
--   • plan_limits                    (every metric, every tier: tokens, minutes,
--                                     storage, SMS, contacts — metered capacity
--                                     and per-unit cost, not capability. Every
--                                     metric already exists on every tier and
--                                     none of them is zero.)
--   • feature_flags.*_limit          — the per-tier usage quotas, WITH ONE
--                                     EXCEPTION handled in section 2 below: a
--                                     quota of ZERO is not a smaller allowance,
--                                     it is a denial wearing a quota's clothes.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION 1 — feature_flags: every capability brokerage has, solo and team have
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ── MEASURED LIVE, before this file (all 68 rows read; 68 enabled, 0 deprecated,
--    0 superadmin_only). Only rows where solo or team differs from brokerage: ──
--
--   feature_key               solo  team  brokerage  multi   verdict
--   campaign_roi_dashboard      f     t       t        t     → open solo
--   competitor_monitor          f     t       t        t     → open solo
--   custom_reports              f     t       t        t     → open solo
--   omnipresence_repurposer     f     t       t        t     → open solo
--   provider_override           f     t       t        t     → open solo
--   team_dashboard              f     t       t        t     → open solo
--   team_management             f     t       t        t     → open solo
--   multi_location_dashboard    f     f       f        t     → LEAVE (above brokerage)
--   multi_location_settings     f     f       f        t     → LEAVE (above brokerage)
--
-- That is the exact list m524 deferred, verified against live rather than
-- inherited: seven rows, all denied to SOLO only — team already had every one.
-- The remaining 59 rows were already at parity.
--
-- "a solo tenant has no team" was the stated reason for team_dashboard /
-- team_management. It is true and it is not a reason to DENY: a tenant with no
-- team sees an empty team board, which is what an empty board is for. Denying
-- it means a solo tenant who hires their second seat has to change plans to see
-- the two of them, which is precisely the "mini brokerage" the owner ruled out.
--
-- The UPDATE is written as a PREDICATE over brokerage_access rather than a list
-- of seven keys on purpose: a key added to the catalogue tomorrow at
-- brokerage-only lands in the same defect, and this statement is the shape that
-- can be re-run to prove parity rather than a snapshot that silently ages.

BEGIN;

UPDATE public.feature_flags
   SET solo_agent_access = true,
       team_access       = true,
       updated_at        = now()
 WHERE brokerage_access = true
   AND (solo_agent_access = false OR team_access = false);

-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION 2 — the denial that was wearing a quota's clothes
-- ═════════════════════════════════════════════════════════════════════════════
--
--   feature_key               solo_limit  team  brokerage  multi
--   listing_marketing_tiers        0        5       10       25
--
-- solo_agent_access is TRUE on this row, so it reads as granted. It is not:
-- lib/entitlements/resolve.ts refuses on `current >= limit`, and usage starts at
-- 0, so a limit of 0 denies the FIRST use and every use after it — the tenant is
-- told "Usage limit reached (0/0 this billing period)" for a feature the
-- catalogue says they have.
--
-- Every other *_limit in the table is left exactly as it is: 3/15/50/200 is a
-- quota ladder, which is capacity, which is what the tiers are allowed to
-- differ on. ZERO is not a rung on that ladder. It is raised to the lowest
-- rung that actually exists — team's 5 — which grants the capability without
-- inventing a number, and leaves the ladder's shape (5/5/10/25) intact.

UPDATE public.feature_flags
   SET solo_agent_limit = 5,
       updated_at       = now()
 WHERE feature_key = 'listing_marketing_tiers'
   AND solo_agent_limit = 0;

-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION 3 — remotion_compositions.tier_access: the SECOND feature matrix
-- ═════════════════════════════════════════════════════════════════════════════
--
-- feature_flags is not the only per-tier access table. `remotion_compositions`
-- carries `tier_access text[]`, and lib/remotion/registry.ts
-- `canAccessComposition` admits a caller whose tier RANK is >= the LOWEST tier
-- named in the row (ranks: solo 1 · team 2 · brokerage 3 · multi_location 4 ·
-- platform 5). So the row's floor is what matters, not its membership.
--
-- ── MEASURED LIVE, before this file (33 active compositions) ─────────────────
--
--   floor = team        → 16 rows, solo denied:
--     AffordabilitySnapshotReel, AgentExplainerReel, AgentTalkingHeadReel,
--     BuyerConsultationSlide, CarouselSlide, ComingSoonReel, DoorHanger,
--     EquityReportReel, ExplainerAnimReel, LeadMagnetCard, ListingFlyer,
--     ListingPresentationSlide, PartnersMeetingReel, PhotoWalkthroughReel,
--     PostcardBack6x9, PostcardFront6x9
--   floor = brokerage   → 5 rows, solo AND team denied:
--     JustListedReelHorizontal, MarketUpdateReel, NeighborhoodSpotlightReel,
--     NewsletterDigestThumb, NewsletterDigestVideo
--   floor = solo        → 11 rows, already at parity
--   floor = platform    → 1 row: ProductPromoReel — LEFT ALONE. 'platform' is
--                         above multi_location; that is the platform's own
--                         promo asset, not a tenant capability.
--
-- 21 compositions were the tier ladder the ruling abolishes — a solo agent
-- could not render a listing flyer or a postcard back. Opened to the floor.
-- ProductPromoReel is excluded by naming 'brokerage' in the predicate: it is
-- the one active row that does not carry it.

UPDATE public.remotion_compositions
   SET tier_access = (
         SELECT array_agg(DISTINCT t ORDER BY t)
           FROM unnest(tier_access || ARRAY['team','solo_agent']) AS t
       ),
       updated_at = now()
 WHERE 'brokerage' = ANY(tier_access)
   AND NOT ('solo_agent' = ANY(tier_access) AND 'team' = ANY(tier_access));

-- ═════════════════════════════════════════════════════════════════════════════
-- POSTCONDITIONS — an UPDATE that matched nothing must not read as success,
-- and each check carries a POSITIVE CONTROL: a statement that proves the check
-- can still go RED, not just that it went green (CLAUDE.md §2).
-- ═════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_flags        int;
  v_denied       int;
  v_zero_limit   int;
  v_comps        int;
  v_comp_denied  int;
  v_ml_only      int;
  v_platform     int;
BEGIN
  -- ── 1. The catalogue is still the catalogue ──────────────────────────────
  SELECT count(*) INTO v_flags FROM public.feature_flags;
  IF v_flags < 60 THEN
    RAISE EXCEPTION 'm527: only % feature_flags rows — the catalogue moved; re-derive before applying', v_flags;
  END IF;

  -- ── 2. Parity: nothing brokerage has may be denied to solo or team ───────
  SELECT count(*) INTO v_denied
    FROM public.feature_flags
   WHERE brokerage_access = true
     AND (solo_agent_access = false OR team_access = false);
  IF v_denied <> 0 THEN
    RAISE EXCEPTION 'm527: % capabilities are still denied to solo or team that brokerage has', v_denied;
  END IF;

  -- POSITIVE CONTROL for check 2 — prove the finder can see a denial at all.
  -- If this count is 0 the predicate is blind and its clean report is worthless.
  SELECT count(*) INTO v_denied
    FROM (SELECT true AS brokerage_access, false AS solo_agent_access, true AS team_access) AS control
   WHERE control.brokerage_access = true
     AND (control.solo_agent_access = false OR control.team_access = false);
  IF v_denied <> 1 THEN
    RAISE EXCEPTION 'm527: parity check is BLIND — it did not flag a synthetic brokerage-only row';
  END IF;

  -- ── 3. No capability is granted with a zero quota ────────────────────────
  SELECT count(*) INTO v_zero_limit
    FROM public.feature_flags
   WHERE (solo_agent_access AND solo_agent_limit = 0)
      OR (team_access       AND team_limit       = 0)
      OR (brokerage_access  AND brokerage_limit  = 0);
  IF v_zero_limit <> 0 THEN
    RAISE EXCEPTION 'm527: % rows grant access with a limit of 0 — a denial wearing a quota', v_zero_limit;
  END IF;

  -- ── 4. multi_location-only rows are UNTOUCHED (parity is to brokerage) ───
  SELECT count(*) INTO v_ml_only
    FROM public.feature_flags
   WHERE multi_location_access AND NOT brokerage_access;
  IF v_ml_only <> 2 THEN
    RAISE EXCEPTION 'm527: expected 2 multi_location-only rows (multi_location_dashboard, multi_location_settings), found %', v_ml_only;
  END IF;

  -- ── 5. Composition parity ────────────────────────────────────────────────
  SELECT count(*) INTO v_comps FROM public.remotion_compositions WHERE is_active;
  IF v_comps < 30 THEN
    RAISE EXCEPTION 'm527: only % active compositions — the registry moved; re-derive before applying', v_comps;
  END IF;

  SELECT count(*) INTO v_comp_denied
    FROM public.remotion_compositions
   WHERE is_active
     AND 'brokerage' = ANY(tier_access)
     AND NOT ('solo_agent' = ANY(tier_access) AND 'team' = ANY(tier_access));
  IF v_comp_denied <> 0 THEN
    RAISE EXCEPTION 'm527: % compositions still floor above solo/team', v_comp_denied;
  END IF;

  -- POSITIVE CONTROL for check 5 — the same predicate against a synthetic row.
  SELECT count(*) INTO v_comp_denied
    FROM (SELECT ARRAY['platform','multi_location','brokerage']::text[] AS tier_access) AS control
   WHERE 'brokerage' = ANY(control.tier_access)
     AND NOT ('solo_agent' = ANY(control.tier_access) AND 'team' = ANY(control.tier_access));
  IF v_comp_denied <> 1 THEN
    RAISE EXCEPTION 'm527: composition parity check is BLIND — it did not flag a synthetic brokerage-floored row';
  END IF;

  -- ── 6. The platform-only composition stayed platform-only ────────────────
  SELECT count(*) INTO v_platform
    FROM public.remotion_compositions
   WHERE is_active AND tier_access = ARRAY['platform']::text[];
  IF v_platform <> 1 THEN
    RAISE EXCEPTION 'm527: expected ProductPromoReel to remain platform-only, found % platform-only rows', v_platform;
  END IF;
END $$;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════════
-- NOT CHANGED, AND WHY — so the next lane does not read silence as agreement
-- ═════════════════════════════════════════════════════════════════════════════
--
--  • subscription_tiers.features (JSONB) was MEASURED and is ALREADY at parity:
--    solo_agent, team and brokerage all carry the identical six keys
--    {portal, basic_ai, core_crm, compliance, team_features, accounting_sync}.
--    multi_location adds usage_metering + multi_brokerage — above brokerage,
--    left alone. No statement needed; recorded so the absence is a measurement
--    rather than an oversight.
--
--  • subscription_tiers.max_agents (2 / 5 / null / null) — THE SEAT RULING.
--    Untouched on purpose.
--
--  • plan_limits — every metered metric at every tier. Capacity and per-unit
--    cost. Untouched. NOTE FOR THE OWNER, unresolved: plan_limits carries
--    metric='active_users' at limit_value 50 for `brokerage`, while
--    subscription_tiers.max_agents says brokerage is UNLIMITED. Two numbers for
--    one seat cap. m523 aligned max_agents with the catalogue; this row was not
--    part of that and is reported, not changed — it is a seat number, and seats
--    are not this lane's to move.
--
--  • lib/kernel/tier-role-matrix.ts TIER_INVITABLE_ROLES still withholds
--    `broker` and `broker_owner` from solo and team. NOT a violation of this
--    ruling and deliberately preserved: the owner ruled those two separately
--    and verbatim ("no solo agent tier subscription does NOT have a broker
--    owner or broker"; "if team tier subscriptions, they don't have a broker in
--    the subscription so the team lead can see leads"), and the SECOND of those
--    is the PREMISE of the lead-desk ruling — a team tier that could hire a
--    broker would contradict the sentence that admits the team lead to the lead
--    desk. Roles are how seats are spent, not which features exist.
