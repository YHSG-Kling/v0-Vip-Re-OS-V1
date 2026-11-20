-- m528 — THE LAST PLACE THE SEAT NUMBER WAS SPELLED TWICE.
--
-- m523 fixed this for solo_agent and team: `subscription_tiers.max_agents` said
-- 1 and 10 while the gate enforced 2 and 5, and max_agents is what the billing
-- page prints, what the upgrade modal prints, and what the platform voice
-- receptionist READS ALOUD to a caller. A prospect was quoted the wrong number.
--
-- One row was left divergent, and it is the brokerage tier:
--
--   tier            max_agents (ENFORCES)   plan_limits.active_users (DISPLAYS)
--   solo_agent      2                       2      ✓ aligned by m523
--   team            5                       5      ✓ aligned by m523
--   brokerage       NULL  (unlimited)       50     ✗  <-- this migration
--   multi_location  NULL  (unlimited)       -1     ✓ already the sentinel
--
-- WHICH ONE IS REAL, MEASURED RATHER THAN ASSUMED. `lib/kernel/seat-usage.ts`
-- `resolveCatalogSeatLimits` selects `tier_name, max_agents` from
-- subscription_tiers and NOTHING ELSE; NULL and negative both normalise to
-- unlimited (:161-165). `plan_limits.active_users` is read in exactly one place,
-- `app/actions/usage-overview.ts`, where `:44` maps it to the display label
-- "Active users". No enforcement path reads that metric. So brokerage enforces
-- UNLIMITED and displays 50.
--
-- WHY THIS IS ALIGNMENT AND NOT A POLICY CHANGE. Unlimited is not something this
-- wave introduced: m523 carried a postcondition REQUIRING brokerage and
-- multi_location to be NULL or negative, and it passed on the way in. The
-- catalogue already said unlimited before anyone touched it. This migration
-- moves only the number that is shown, onto the number that is already enforced.
--
-- DIRECTION MATTERS. The solo/team defect OVERSTATED entitlement (quoted 10 on a
-- plan granting 5). This one UNDERSTATES it: a brokerage looking at their usage
-- page sees a 50-seat ceiling they do not actually have. Same class — the shown
-- number is not the enforced number — and it is the last instance.
--
-- -1, not NULL: `plan_limits.limit_value` is the metric ladder's own vocabulary
-- and multi_location already spells unlimited as -1 there. One vocabulary per
-- function (CLAUDE.md §6) — do not introduce NULL as a second spelling of
-- unlimited in a column that already has one.

UPDATE public.plan_limits
   SET limit_value = -1,
       updated_at  = now()
 WHERE plan_tier = 'brokerage'
   AND metric    = 'active_users'
   AND limit_value <> -1;

DO $$
DECLARE
  v_brokerage int;
  v_multi     int;
  v_solo      int;
  v_team      int;
  v_maxagents int;
BEGIN
  SELECT limit_value INTO v_brokerage FROM public.plan_limits
   WHERE plan_tier = 'brokerage' AND metric = 'active_users';
  SELECT limit_value INTO v_multi FROM public.plan_limits
   WHERE plan_tier = 'multi_location' AND metric = 'active_users';
  SELECT limit_value INTO v_solo FROM public.plan_limits
   WHERE plan_tier = 'solo_agent' AND metric = 'active_users';
  SELECT limit_value INTO v_team FROM public.plan_limits
   WHERE plan_tier = 'team' AND metric = 'active_users';

  IF v_brokerage IS DISTINCT FROM -1 THEN
    RAISE EXCEPTION 'm528: brokerage active_users is %, expected -1 (unlimited)', v_brokerage;
  END IF;
  IF v_multi IS DISTINCT FROM -1 THEN
    RAISE EXCEPTION 'm528: multi_location active_users moved to % — it should still be -1', v_multi;
  END IF;

  -- m523's work must survive this. A migration that fixes one row and disturbs
  -- the two the previous one aligned is not a fix.
  IF v_solo IS DISTINCT FROM 2 OR v_team IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'm528: solo/team active_users are %/%, expected 2/5 — m523 was disturbed', v_solo, v_team;
  END IF;

  -- And the ENFORCING column must still agree with itself: brokerage unlimited,
  -- solo/team at the owner's numbers. If these ever diverge again, the display
  -- row is the wrong place to look for the cause.
  SELECT max_agents INTO v_maxagents FROM public.subscription_tiers WHERE tier_name = 'brokerage';
  IF v_maxagents IS NOT NULL AND v_maxagents >= 0 THEN
    RAISE EXCEPTION 'm528: subscription_tiers.max_agents for brokerage is % — no longer unlimited, so -1 here would now be the LIE', v_maxagents;
  END IF;
END $$;
