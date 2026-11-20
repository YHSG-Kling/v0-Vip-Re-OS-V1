-- ── APPLIED LIVE 2026-09-23 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
--
-- m660 — SEAT BANDS 2 / 10 / 30 / CUSTOM, AND SEAT PACKAGES SYNCED FROM STRIPE.
-- ─────────────────────────────────────────────────────────────────────────────
-- OWNER RULING, VERBATIM (2026-09-23, wave 79A):
--   "not charging for staff/admin (non producing) and charging producing
--    seats. solo tier is 2 seats; team tier is 10 seats; brokerage tier is 30
--    seats; multi location tier is custom pricing for seats. the fee is setup
--    fee. there will be an opportunity for buying more seat packages and if
--    the tenant hits a limit they will be able to either upgrade to a higher
--    tier (or lower tier if their business changes) or buy more seats.
--    subscriptions will be setup in stripe so they sync."
--
-- SUPERSEDES m655 (2 / 5 / NULL / NULL, applied live 2026-09-22), the same
-- way m655 superseded m529: BOTH seat columns move together and the
-- postcondition loops every tier so the next person to move one has to move
-- both.
--
-- MEASURED LIVE BEFORE THIS FILE (m655's applied postcondition, re-read
-- 2026-09-23 through the caches — NOT re-queried by this lane, which has no
-- live access; the integrator confirms on apply):
--     subscription_tiers.max_agents   solo_agent 2 · team 5 · brokerage NULL · multi_location NULL
--     plan_limits.active_users        solo_agent 2 · team 5 · brokerage -1   · multi_location -1
--
-- THE ONE DERIVATION these must agree with is lib/billing/plan-catalog.ts
-- TIER_SEAT_BANDS (solo_agent 2 · team 10 · brokerage 30 · multi_location
-- NULL = custom). scripts/seat-bands-guard.ts and scripts/seat-packages-guard.ts
-- pin THIS file's CASE numbers to that table, derived rather than retyped.
--
-- UNLIMITED / CUSTOM keeps its two spellings: NULL in subscription_tiers and
-- -1 in plan_limits (each column's existing convention; normalizeCatalogSeatLimit
-- folds both). multi_location's NULL now means CUSTOM: the tenant's negotiated
-- count lives on subscriptions.custom_seat_limit (below); a multi_location
-- tenant with none negotiated is unlimited for the gate.
--
-- SEAT PACKAGES — the columns Stripe syncs into (this file adds them; none
-- existed — checked scripts/schema-snapshot.ts subscription_tiers /
-- subscriptions, 2026-09-23):
--   subscription_tiers.seat_package_size         seats per package unit
--   subscription_tiers.seat_package_price_cents  monthly price per unit (NULL = not priced: NOT sellable)
--   subscription_tiers.stripe_seat_price_id      the Stripe licensed price sold by quantity
--   subscriptions.seat_packages                  units bought (the Stripe item quantity)
--   subscriptions.extra_seats                    seat_packages × size (the number the gate adds to the band)
--   subscriptions.stripe_seat_item_id            the Stripe subscription item carrying them
--   subscriptions.stripe_price_id                the plan item's price as billed (synced)
--   subscriptions.custom_seat_limit              multi_location: the negotiated seat count
--   subscriptions.custom_stripe_price_id         multi_location: the tenant-specific plan price
-- Written by the billing webhook (customer.subscription.created/updated) and
-- the daily reconcile (lib/billing/seat-sync.ts) FROM the Stripe items, and by
-- the superadmin "sync catalogue from Stripe" action FROM the Stripe prices.
-- The seat-package PRICE is deliberately left NULL here: pricing is a
-- commercial decision entered in Stripe (or the plan catalogue) by a person,
-- never invented by a migration (CLAUDE.md §5). Until it is set, the door
-- offers the tier change and says packages are not on sale yet.
--
-- NO ROW IS EJECTED. Seat caps bite on ADD paths only (seatGate); raising
-- team 5→10 and brokerage NULL→30 places no tenant over a cap the gate
-- refuses on — the ONLY live tenant on brokerage today holds far fewer than
-- 30 producers (integrator: confirm with the postcondition's count below,
-- which RAISES if any tenant already exceeds its new band).

-- ── 1. THE BANDS ─────────────────────────────────────────────────────────────
UPDATE public.subscription_tiers SET max_agents = 2    WHERE tier_name = 'solo_agent';
UPDATE public.subscription_tiers SET max_agents = 10   WHERE tier_name = 'team';
UPDATE public.subscription_tiers SET max_agents = 30   WHERE tier_name = 'brokerage';
UPDATE public.subscription_tiers SET max_agents = NULL WHERE tier_name = 'multi_location';

UPDATE public.plan_limits SET limit_value = 2,  updated_at = now() WHERE plan_tier = 'solo_agent'     AND metric = 'active_users';
UPDATE public.plan_limits SET limit_value = 10, updated_at = now() WHERE plan_tier = 'team'           AND metric = 'active_users';
UPDATE public.plan_limits SET limit_value = 30, updated_at = now() WHERE plan_tier = 'brokerage'      AND metric = 'active_users';
UPDATE public.plan_limits SET limit_value = -1, updated_at = now() WHERE plan_tier = 'multi_location' AND metric = 'active_users';

COMMENT ON COLUMN public.subscription_tiers.max_agents IS
  'Seat BAND for the tier: the number of PRODUCERS (users holding an active agents record, or typed agent/team_lead) included in the plan — solo_agent 2, team 10, brokerage 30 (owner ruling 2026-09-23, wave 79A). Staff and non-producing brokers never consume a seat (lib/kernel/tier-role-matrix.ts roleConsumesSeat). NULL = CUSTOM (multi_location: subscriptions.custom_seat_limit, unlimited when none negotiated). The EFFECTIVE limit is this band + subscriptions.extra_seats (purchased seat packages). lib/billing/plan-catalog.ts TIER_SEAT_BANDS is the code-side statement the gate falls back to.';

-- ── 2. SEAT PACKAGES ON THE CATALOGUE ────────────────────────────────────────
ALTER TABLE public.subscription_tiers
  ADD COLUMN IF NOT EXISTS seat_package_size        integer,
  ADD COLUMN IF NOT EXISTS seat_package_price_cents integer,
  ADD COLUMN IF NOT EXISTS stripe_seat_price_id     text;

ALTER TABLE public.subscription_tiers
  DROP CONSTRAINT IF EXISTS subscription_tiers_seat_package_size_check,
  ADD  CONSTRAINT subscription_tiers_seat_package_size_check
    CHECK (seat_package_size IS NULL OR seat_package_size >= 1);
ALTER TABLE public.subscription_tiers
  DROP CONSTRAINT IF EXISTS subscription_tiers_seat_package_price_cents_check,
  ADD  CONSTRAINT subscription_tiers_seat_package_price_cents_check
    CHECK (seat_package_price_cents IS NULL OR seat_package_price_cents >= 0);

-- The package SIZE is product shape (a decision the owner made: "seat
-- packages"); the PRICE is not set here. 5 seats per package on the capped
-- tiers; none on the custom tier.
UPDATE public.subscription_tiers SET seat_package_size = 5 WHERE tier_name IN ('solo_agent', 'team', 'brokerage') AND seat_package_size IS NULL;

COMMENT ON COLUMN public.subscription_tiers.seat_package_size IS
  'Seats per seat-package unit (wave 79A). Sold on Stripe as a licensed price by QUANTITY (stripe_seat_price_id); subscriptions.extra_seats = seat_packages × this. NULL = the tier sells no packages (multi_location: custom pricing).';
COMMENT ON COLUMN public.subscription_tiers.seat_package_price_cents IS
  'Monthly price per seat-package unit, integer cents, SYNCED FROM STRIPE (superadmin sync action / plan catalogue). NULL = not priced: the seat door will not offer a package (fail closed — never a button that charges nothing).';
COMMENT ON COLUMN public.subscription_tiers.stripe_seat_price_id IS
  'The Stripe licensed price (metadata kind=seat_package, tier_name=<tier>) the seat package is sold on, quantity = packages. NULL = not linked: packages cannot be bought.';

-- ── 3. THE TENANT''S SEAT TERMS ON ITS SUBSCRIPTION ROW ──────────────────────
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS seat_packages          integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extra_seats            integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stripe_seat_item_id    text,
  ADD COLUMN IF NOT EXISTS stripe_price_id        text,
  ADD COLUMN IF NOT EXISTS custom_seat_limit      integer,
  ADD COLUMN IF NOT EXISTS custom_stripe_price_id text;

ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_seat_packages_check,
  ADD  CONSTRAINT subscriptions_seat_packages_check CHECK (seat_packages >= 0);
ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_extra_seats_check,
  ADD  CONSTRAINT subscriptions_extra_seats_check CHECK (extra_seats >= 0);
ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_custom_seat_limit_check,
  ADD  CONSTRAINT subscriptions_custom_seat_limit_check CHECK (custom_seat_limit IS NULL OR custom_seat_limit >= 0);

COMMENT ON COLUMN public.subscriptions.seat_packages IS
  'Seat-package units bought — the QUANTITY on the Stripe seat item (stripe_seat_item_id). Written from Stripe by the billing webhook and the daily reconcile (lib/billing/seat-sync.ts), and by the tenant seat door after Stripe accepts the change (app/actions/billing.ts buySeatPackagesAction). Stripe is the source.';
COMMENT ON COLUMN public.subscriptions.extra_seats IS
  'Seats beyond the tier band that this tenant has purchased: seat_packages × subscription_tiers.seat_package_size. The seat gate (lib/kernel/seat-usage.ts) adds it to the band: effective limit = band + extra_seats.';
COMMENT ON COLUMN public.subscriptions.stripe_seat_item_id IS
  'The Stripe subscription item (si_…) carrying the seat packages; NULL when none bought.';
COMMENT ON COLUMN public.subscriptions.stripe_price_id IS
  'The plan item''s Stripe price as actually billed (synced from the subscription items). Differs from subscription_tiers.stripe_price_id on a custom-priced multi_location tenant.';
COMMENT ON COLUMN public.subscriptions.custom_seat_limit IS
  'multi_location only: the NEGOTIATED seat count (custom pricing, set by platform staff). NULL = nothing negotiated = unlimited for the gate. Overrides the tier band; brokerages.billing_metadata.seat_override still wins over both.';
COMMENT ON COLUMN public.subscriptions.custom_stripe_price_id IS
  'multi_location only: the tenant-specific Stripe plan price the negotiated deal is billed on.';

-- ── POSTCONDITION — the ladder, both columns, every tier, no tenant over its band, or refuse ──
DO $$
DECLARE
  r RECORD;
  v_expected_tier  int;   -- subscription_tiers.max_agents spelling (NULL = custom/unlimited)
  v_expected_plan  int;   -- plan_limits.active_users spelling (-1 = unlimited)
  v_checked int := 0;
  v_over int := 0;
BEGIN
  FOR r IN
    SELECT t.tier_name,
           t.max_agents,
           t.seat_package_size,
           (SELECT l.limit_value FROM public.plan_limits l
             WHERE l.plan_tier = t.tier_name AND l.metric = 'active_users') AS active_users
      FROM public.subscription_tiers t
     WHERE t.tier_name IN ('solo_agent', 'team', 'brokerage', 'multi_location')
  LOOP
    v_checked := v_checked + 1;
    v_expected_tier := CASE r.tier_name
                         WHEN 'solo_agent' THEN 2
                         WHEN 'team'       THEN 10
                         WHEN 'brokerage'  THEN 30
                         ELSE NULL             -- multi_location: custom
                       END;
    v_expected_plan := CASE r.tier_name
                         WHEN 'solo_agent' THEN 2
                         WHEN 'team'       THEN 10
                         WHEN 'brokerage'  THEN 30
                         ELSE -1
                       END;
    IF r.max_agents IS DISTINCT FROM v_expected_tier THEN
      RAISE EXCEPTION 'm660: subscription_tiers.max_agents for % is % — expected % (TIER_SEAT_BANDS)',
        r.tier_name, COALESCE(r.max_agents::text, 'NULL'), COALESCE(v_expected_tier::text, 'NULL');
    END IF;
    IF r.active_users IS NOT NULL AND r.active_users IS DISTINCT FROM v_expected_plan THEN
      RAISE EXCEPTION 'm660: plan_limits.active_users for % is % — expected %',
        r.tier_name, r.active_users, v_expected_plan;
    END IF;
    IF r.tier_name <> 'multi_location' AND (r.seat_package_size IS NULL OR r.seat_package_size < 1) THEN
      RAISE EXCEPTION 'm660: subscription_tiers.seat_package_size for % is % — a capped tier sells packages', r.tier_name, COALESCE(r.seat_package_size::text, 'NULL');
    END IF;
  END LOOP;
  IF v_checked <> 4 THEN
    RAISE EXCEPTION 'm660: expected the four canonical tiers in subscription_tiers, found %', v_checked;
  END IF;

  -- No tenant may already sit past its NEW band: producers (agent/team_lead by
  -- type, or any active agents record) per brokerage vs the band. RAISES so the
  -- integrator sees the tenant by name rather than discovering a locked door.
  SELECT count(*) INTO v_over
    FROM (
      SELECT b.id, b.plan_tier,
             (SELECT count(DISTINCT u.id) FROM public.users u
               LEFT JOIN public.agents a ON a.user_id = u.id AND a.brokerage_id = b.id AND a.is_active IS DISTINCT FROM false
              WHERE u.brokerage_id = b.id AND u.status IS DISTINCT FROM 'suspended'
                AND (u.user_type IN ('agent', 'team_lead') OR (u.user_type IN ('broker', 'broker_owner', 'admin') AND a.id IS NOT NULL))) AS producers,
             t.max_agents AS band
        FROM public.brokerages b
        JOIN public.subscription_tiers t ON t.tier_name = b.plan_tier
    ) x
   WHERE x.band IS NOT NULL AND x.producers > x.band;
  IF v_over > 0 THEN
    RAISE EXCEPTION 'm660: % tenant(s) already seat more producers than their new band — raise their seat_override or buy packages before applying', v_over;
  END IF;
END $$;
