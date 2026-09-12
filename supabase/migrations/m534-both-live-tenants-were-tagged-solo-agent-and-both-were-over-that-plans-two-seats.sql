-- m534 — BOTH LIVE TENANTS WERE TAGGED `solo_agent`, AND BOTH WERE OVER THAT
--        PLAN'S TWO SEATS. NEITHER COULD ADD A PERSON.
--
-- APPLICATION STATUS: APPLIED, 2026-08-23, by the integrator.
--
-- VERIFIED LIVE AFTER APPLYING:
--     VIP Premier Realty ... solo_agent → brokerage (50 seats; 10 staff seats,
--                            which is over team's cap of 5, so `team` would
--                            have left it over-limit on day one)
--     Your Brokerage ....... solo_agent → team (5 seats; 3 staff, 0 teams)
--     tenants over their seat cap ................................... 0
--     subscriptions table .......................... 0 rows, so plan_tier was
--                            the ONLY tier statement and nothing was overridden
--     POSITIVE CONTROL: the same seat gate still REFUSES 10 seats on
--         solo_agent, and Your Brokerage filled to 5/5 refuses the 6th add —
--         so the cap still bites; this widened a wrong tag, not the gate.
--
-- ── THE OWNER'S RULING THAT MAKES THIS A DATA FIX AND NOT A BILLING CHANGE ──
--
--   "the data in the live db is old demo data and doesn't mean anything in
--    todays structure."                                    (owner, 2026-08-23)
--
-- Both tags are demo-seed drift, not subscriptions. MEASURED: `subscriptions`
-- holds ZERO rows on this database, so there is no Stripe subscription for
-- lib/billing/sync-plan-tier.ts to have copied down, and nothing is being
-- overridden — `plan_tier` is the ONLY statement of tier that exists here.
--
-- ── WHAT WAS BROKEN, AND FOR WHOM ───────────────────────────────────────────
--
-- `solo_agent` caps at 2 seats (subscription_tiers.max_agents = 2,
-- plan_limits.active_users = 2, TIER_SEAT_LIMITS.solo_agent = 2 — all three
-- agree, measured live). MEASURED SEAT COUNTS, using resolveSeatUsage's own
-- definition (distinct non-suspended users holding a SEAT_ROLE by
-- users.user_type OR by user_role_assignments):
--
--   VIP Premier Realty   10 seats / 18 people / 1 live team   cap 2   → 8 OVER
--   Your Brokerage        3 seats /  5 people / 0 teams       cap 2   → 1 OVER
--
-- Nobody is ejected — `seatGate` is on the ADD paths only — but every add path
-- refuses on both tenants: the tenant invite, the god-console create, the
-- recruiting provisioner, a role CHANGE through updateUser, and REACTIVATING a
-- suspended user. That is the whole of "cannot invite, provision, promote into a
-- seat role, or reactivate anyone", and it blocks testing.
--
-- ── THE TIER EACH TENANT'S SHAPE IMPLIES ────────────────────────────────────
--
-- VIP Premier Realty → `brokerage` (50 seats)
--   · 10 staff seats. That is ABOVE team's cap of 5, so `team` would leave the
--     tenant over its limit on the day it was set — the same defect in a new
--     costume. `brokerage` is the smallest tier that actually fits, which is the
--     direction lib/billing/plan-tier.ts documents as fail-safe (never hand a
--     tenant a wider plan than its shape needs).
--   · The ROSTER is a brokerage roster, not a team roster: a broker
--     (broker@vip.demo), an office admin, a compliance officer, a transaction
--     coordinator, an ISA and four agents. m473 rules that a team IS a mini
--     brokerage — but this tenant is not a team, it CONTAINS one (Williams Elite
--     Team, led by teamlead@vip.demo). A tenant with a broker above a team lead
--     is the brokerage shape by definition.
--   · NOT `multi_location`: there is one office. multi_location is unlimited
--     seats and carries capabilities above brokerage (multi_location_dashboard,
--     multi_location_settings, BYO voice trunk), and handing those to a
--     single-office tenant is exactly the free upgrade the tier floor exists to
--     prevent.
--
-- Your Brokerage → `team` (5 seats)
--   · 3 staff seats — above solo's 2, at or under team's 5.
--   · 0 live teams and no broker. An admin, an agent, and one seat carrying
--     user_type='team_lead' (buyer@yourbrokerage.com, who leads NO team row —
--     m473's finding, and the reason m526 anchors on teams.team_lead_id rather
--     than on that label).
--   · `team` is the smallest tier that fits. Not `brokerage`: nothing in this
--     tenant's shape asks for 50 seats, and the floor direction is downward.
--
-- ── WHAT THIS CHANGES BESIDES SEATS — STATED, NOT DISCOVERED LATER ──────────
--
-- `plan_tier` is read by more than the seat gate, so this tag is load-bearing in
-- three other places and every one of them moves in the direction the shape
-- implies:
--   · lib/kernel/0.1-feature-access.ts canAccessFeature reads the tier's
--     feature_flags columns and per-tier quota. VIP moves from solo columns to
--     brokerage columns; Your Brokerage from solo to team. (m527, applied next,
--     is what makes those columns agree with the owner's parity ruling.)
--   · plan_limits per-metric quotas move with the tier (e.g. ai_tokens_monthly
--     2M → 30M for VIP, 2M → 10M for Your Brokerage). These are CAPACITY, which
--     is what tiers are allowed to differ on.
--   · public.is_tenant_principal_team_lead() (m526) is tier-conditional on
--     exactly this column. See the note below — this is the interesting one.
--
-- ── THE m526 INTERACTION, STATED UP FRONT ───────────────────────────────────
--
-- m526 grants a tenant's books to the lead of a TEAM-SCALE tenant's single team.
-- Its header measured "exactly one answer moves — teamlead@vip.demo false →
-- TRUE" against a database where VIP was tagged solo_agent, and its own header
-- says of that tag: "demo-seed drift ... if that tag is wrong, the fix is the
-- tag." This file IS that fix, and it therefore RETIRES that +1 rather than
-- delivering it: on `brokerage` tier m472/m473 stand, and VIP's team lead reads
-- their own team's books and not the office's. That is not a regression, it is
-- the ruling — VIP already has a broker and an office admin who keep its books,
-- so the hole m526 exists to close ("nobody can read this tenant's financials")
-- never existed on this tenant.
--
-- ── NOT DONE HERE ───────────────────────────────────────────────────────────
-- No `subscriptions` row is invented. A tier tag is not a subscription, and
-- fabricating a billing record to justify a demo tag would be a wrong invoice
-- waiting to happen. When a real subscription arrives,
-- lib/billing/sync-plan-tier.ts overwrites this column from it, as designed.

BEGIN;

UPDATE public.brokerages
   SET plan_tier  = 'brokerage',
       updated_at = now()
 WHERE id = 'b0000000-0000-0000-0000-000000000001'   -- VIP Premier Realty
   AND plan_tier = 'solo_agent';

UPDATE public.brokerages
   SET plan_tier  = 'team',
       updated_at = now()
 WHERE id = '231f4e64-5022-4752-8047-696886551c35'   -- Your Brokerage
   AND plan_tier = 'solo_agent';

-- ── POSTCONDITION — the tags landed, and EVERY tenant now fits its own cap ──
DO $$
DECLARE
  v_bad text;
  v_ctl integer;
BEGIN
  IF (SELECT plan_tier FROM public.brokerages WHERE id='b0000000-0000-0000-0000-000000000001') <> 'brokerage' THEN
    RAISE EXCEPTION 'm534: VIP Premier Realty did not take plan_tier=brokerage';
  END IF;
  IF (SELECT plan_tier FROM public.brokerages WHERE id='231f4e64-5022-4752-8047-696886551c35') <> 'team' THEN
    RAISE EXCEPTION 'm534: Your Brokerage did not take plan_tier=team';
  END IF;

  -- The POINT of the change: no live tenant may sit over its own seat cap, or
  -- the add paths stay shut. Counted exactly as lib/kernel/seat-usage.ts
  -- resolveSeatUsage counts, and compared to the ADMINISTERED cap
  -- (subscription_tiers.max_agents), not to a literal.
  SELECT string_agg(format('%s: %s seats > cap %s (tier %s)', name, seats, cap, plan_tier), '; ')
    INTO v_bad
  FROM (
    SELECT b.name, b.plan_tier, st.max_agents AS cap,
           (SELECT count(DISTINCT u.id) FROM public.users u
             WHERE u.brokerage_id = b.id
               AND u.status IS DISTINCT FROM 'suspended'
               AND (u.user_type IN ('admin','broker','broker_admin','broker_owner','team_lead','agent','tc','isa','compliance_officer')
                    OR EXISTS (SELECT 1 FROM public.user_role_assignments ura
                                WHERE ura.user_id = u.id
                                  AND ura.role IN ('admin','broker','broker_admin','broker_owner','team_lead','agent','tc','isa','compliance_officer')))
           ) AS seats
    FROM public.brokerages b
    JOIN public.subscription_tiers st ON st.tier_name = b.plan_tier AND st.is_active
    WHERE b.deleted_at IS NULL
  ) q
  WHERE cap IS NOT NULL AND seats > cap;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'm534: a tenant is STILL over its seat cap — %', v_bad;
  END IF;

  -- POSITIVE CONTROL (§2). "0 tenants over cap" and "the over-cap finder is
  -- broken" are the same output. Re-run the identical shape against the cap the
  -- tenants JUST LEFT (solo_agent = 2) and require it to find both of them.
  SELECT count(*) INTO v_ctl
  FROM (
    SELECT (SELECT count(DISTINCT u.id) FROM public.users u
             WHERE u.brokerage_id = b.id
               AND u.status IS DISTINCT FROM 'suspended'
               AND (u.user_type IN ('admin','broker','broker_admin','broker_owner','team_lead','agent','tc','isa','compliance_officer')
                    OR EXISTS (SELECT 1 FROM public.user_role_assignments ura
                                WHERE ura.user_id = u.id
                                  AND ura.role IN ('admin','broker','broker_admin','broker_owner','team_lead','agent','tc','isa','compliance_officer')))
           ) AS seats
    FROM public.brokerages b WHERE b.deleted_at IS NULL
  ) q
  WHERE seats > (SELECT max_agents FROM public.subscription_tiers WHERE tier_name='solo_agent');

  IF v_ctl < 2 THEN
    RAISE EXCEPTION 'm534: POSITIVE CONTROL FAILED — the over-cap finder found only % tenant(s) over the solo cap of 2, so its clean result above proves nothing', v_ctl;
  END IF;

  RAISE NOTICE 'm534 OK — 0 tenants over their own cap; control confirms % would still be over the solo cap they left.', v_ctl;
END $$;

COMMIT;
