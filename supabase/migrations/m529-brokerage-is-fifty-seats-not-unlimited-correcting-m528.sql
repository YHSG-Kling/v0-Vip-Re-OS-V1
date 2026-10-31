-- m529 — BROKERAGE IS 50 SEATS. CORRECTS m528, WHICH RESOLVED A DISAGREEMENT THE WRONG WAY.
-- APPLIED 2026-08-22.
--
-- Owner ruling, verbatim: "a brokerage should be changed to 50 seats with a brokerage tier
-- subscription … and then the same goes for multiple location brokerages but unlimited seats."
--
-- WHAT WENT WRONG, RECORDED SO IT IS NOT REPEATED. Two columns disagreed about the brokerage
-- seat cap BEFORE this session touched either:
--     subscription_tiers.max_agents   NULL   (the ENFORCING column)
--     plan_limits.active_users        50     (the DISPLAYING column)
-- m528 asked "which column does the gate consume?" — resolveCatalogSeatLimits selects
-- max_agents and nothing else — concluded the enforced value was authoritative, and moved the
-- display onto it, making brokerage unlimited.
--
-- The reasoning was sound and the conclusion was wrong. "Which column does the code read?"
-- answers where the CURRENT BEHAVIOUR comes from. It does not answer what the number is
-- SUPPOSED to be. That is a product fact, and the disagreement was itself the evidence that
-- nobody had decided it. It was raised for the owner and then resolved without waiting for the
-- answer. plan_limits held the right number the whole time.
--
-- THE CORRECTED LADDER, all four tiers, one place:
--     solo_agent       2         (m523)
--     team             5         (m523)
--     brokerage       50         <-- this migration, BOTH columns
--     multi_location  unlimited  (NULL / -1)
--
-- Both columns are set together and asserted together, because the reason this was wrong is
-- that they were allowed to disagree at all. The postcondition loops every tier and fails on
-- ANY divergence between the two spellings — so the next person to move one has to move both.
--
-- FOLLOW-ON, NOT PART OF THIS FILE: lib/kernel/tier-role-matrix.ts TIER_SEAT_LIMITS.brokerage
-- was also `null`. That literal is the FALLBACK used when the catalogue cannot be read, so it
-- was a fail-OPEN answer on the seat axis at exactly the moment the real number is
-- unavailable. Corrected to 50 in the same wave (CLAUDE.md §4).

UPDATE public.subscription_tiers
   SET max_agents = 50
 WHERE tier_name = 'brokerage';

UPDATE public.plan_limits
   SET limit_value = 50,
       updated_at  = now()
 WHERE plan_tier = 'brokerage'
   AND metric    = 'active_users';

DO $$
DECLARE
  r RECORD;
  v_expected int;
BEGIN
  FOR r IN
    SELECT t.tier_name,
           t.max_agents,
           (SELECT limit_value FROM public.plan_limits l
             WHERE l.plan_tier = t.tier_name AND l.metric = 'active_users') AS active_users
      FROM public.subscription_tiers t
  LOOP
    v_expected := CASE r.tier_name
                    WHEN 'solo_agent' THEN 2
                    WHEN 'team'       THEN 5
                    WHEN 'brokerage'  THEN 50
                    ELSE NULL          -- multi_location: unlimited
                  END;

    IF v_expected IS NULL THEN
      IF r.max_agents IS NOT NULL AND r.max_agents >= 0 THEN
        RAISE EXCEPTION 'm529: % max_agents is % — expected unlimited', r.tier_name, r.max_agents;
      END IF;
      IF r.active_users IS DISTINCT FROM -1 THEN
        RAISE EXCEPTION 'm529: % active_users is % — expected -1 (unlimited)', r.tier_name, r.active_users;
      END IF;
    ELSE
      IF r.max_agents IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION 'm529: % max_agents is %, expected %', r.tier_name, r.max_agents, v_expected;
      END IF;
      IF r.active_users IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION 'm529: % active_users is %, expected % — the two columns disagree again, which is the defect m528 got wrong', r.tier_name, r.active_users, v_expected;
      END IF;
    END IF;
  END LOOP;
END $$;
