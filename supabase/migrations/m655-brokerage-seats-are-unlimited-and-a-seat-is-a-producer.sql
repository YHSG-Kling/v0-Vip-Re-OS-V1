-- ── APPLIED LIVE 2026-09-22 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) — postcondition passed ──
--
-- m655 — BROKERAGE SEATS ARE UNLIMITED, AND A SEAT IS A PRODUCER.
-- ─────────────────────────────────────────────────────────────────────────────
-- OWNER RULING, VERBATIM (2026-09-22, wave 78A):
--   "the tier seat bands are solo agent maxseats 2 team is 5 brokerage is
--    unlimited and same to multiple locations is unlimited. … staff should not
--    take up seats. … these seat numbers have already been coded."
--
-- SUPERSEDES m529 ("a brokerage should be changed to 50 seats"), which moved
-- BOTH seat columns to 50 for brokerage and asserted them together. This file
-- does the same in the other direction, for the same reason m529 gave: the two
-- columns were allowed to disagree once, and the postcondition here loops every
-- tier so the next person to move one has to move both.
--
-- MEASURED LIVE BEFORE THIS FILE (scripts/schema-snapshot.ts + m529/m534
-- postconditions, re-read 2026-09-22 through the caches — NOT re-queried by
-- this lane, which has no live access; the integrator confirms on apply):
--     subscription_tiers.max_agents   solo_agent 2 · team 5 · brokerage 50 · multi_location NULL
--     plan_limits.active_users        solo_agent 2 · team 5 · brokerage 50 · multi_location -1
--
-- THE ONE DERIVATION these must agree with is lib/billing/plan-catalog.ts
-- TIER_SEAT_BANDS (solo_agent 2 · team 5 · brokerage NULL · multi_location
-- NULL); lib/kernel/tier-role-matrix.ts TIER_SEAT_LIMITS IS that object, and
-- scripts/seat-bands-guard.ts (npm run test:seat-bands) pins the numbers in
-- THIS file to it, so the catalogue the gate reads first
-- (lib/kernel/seat-usage.ts resolveCatalogSeatLimits) and the fallback it uses
-- when the catalogue is unreadable cannot drift apart again.
--
-- UNLIMITED KEEPS ITS TWO SPELLINGS: NULL in subscription_tiers (what the
-- multi_location row already holds; normalizeCatalogSeatLimit folds NULL and
-- -1) and -1 in plan_limits (its existing convention for multi_location).
-- Folding the two columns onto one spelling is a separate change and not
-- smuggled in here.
--
-- THE COLUMN NAME IS RIGHT NOW. m523 reported `max_agents` as misnamed because
-- a seat was then "any working staff user". Under this ruling a seat is a
-- PRODUCER — an agent, a team lead, or a broker / broker_owner / admin who
-- holds an active agents record; admin, broker_admin, tc, isa and
-- compliance_officer staff are FREE (lib/kernel/tier-role-matrix.ts
-- roleConsumesSeat). The follow-up rename m523 asked for is withdrawn, and the
-- COMMENT ON COLUMN is rewritten to say what the column counts today.
--
-- NO ROW IS EJECTED. Seat caps bite on ADD paths only (seatGate); raising
-- brokerage to unlimited can only admit, and the producer rule can only
-- lower a tenant's count (staff stop counting), so no tenant is placed over
-- its cap by this file. m534's positive control still holds: the solo 3rd
-- producer and the team 6th producer are refused (scripts/seat-cap-simulator.ts).

UPDATE public.subscription_tiers
   SET max_agents = NULL
 WHERE tier_name = 'brokerage';

UPDATE public.plan_limits
   SET limit_value = -1,
       updated_at  = now()
 WHERE plan_tier = 'brokerage'
   AND metric    = 'active_users';

COMMENT ON COLUMN public.subscription_tiers.max_agents IS
  'Seat cap for the tier: the number of PRODUCERS (users holding an active agents record, or typed agent/team_lead) a tenant may seat. Staff — admin, broker_admin, tc, isa, compliance_officer — and non-producing brokers never consume a seat (owner ruling 2026-09-22, wave 78A; lib/kernel/tier-role-matrix.ts roleConsumesSeat). NULL = unlimited (m655: brokerage and multi_location). Administered from the superadmin plan catalogue; lib/billing/plan-catalog.ts TIER_SEAT_BANDS is the code-side statement the gate falls back to.';

-- ── POSTCONDITION — the ladder, both columns, every tier, or refuse ─────────
DO $$
DECLARE
  r RECORD;
  v_expected_tier  int;   -- subscription_tiers.max_agents spelling (NULL = unlimited)
  v_expected_plan  int;   -- plan_limits.active_users spelling (-1 = unlimited)
  v_checked int := 0;
BEGIN
  FOR r IN
    SELECT t.tier_name,
           t.max_agents,
           (SELECT l.limit_value FROM public.plan_limits l
             WHERE l.plan_tier = t.tier_name AND l.metric = 'active_users') AS active_users
      FROM public.subscription_tiers t
     WHERE t.tier_name IN ('solo_agent', 'team', 'brokerage', 'multi_location')
  LOOP
    v_checked := v_checked + 1;
    v_expected_tier := CASE r.tier_name
                         WHEN 'solo_agent' THEN 2
                         WHEN 'team'       THEN 5
                         ELSE NULL             -- brokerage, multi_location: unlimited
                       END;
    v_expected_plan := CASE r.tier_name
                         WHEN 'solo_agent' THEN 2
                         WHEN 'team'       THEN 5
                         ELSE -1
                       END;
    IF r.max_agents IS DISTINCT FROM v_expected_tier THEN
      RAISE EXCEPTION 'm655: subscription_tiers.max_agents for % is % — expected % (TIER_SEAT_BANDS)',
        r.tier_name, COALESCE(r.max_agents::text, 'NULL'), COALESCE(v_expected_tier::text, 'NULL');
    END IF;
    IF r.active_users IS NOT NULL AND r.active_users IS DISTINCT FROM v_expected_plan THEN
      RAISE EXCEPTION 'm655: plan_limits.active_users for % is % — expected %',
        r.tier_name, r.active_users, v_expected_plan;
    END IF;
  END LOOP;
  IF v_checked <> 4 THEN
    RAISE EXCEPTION 'm655: expected the four canonical tiers in subscription_tiers, found %', v_checked;
  END IF;
END $$;
