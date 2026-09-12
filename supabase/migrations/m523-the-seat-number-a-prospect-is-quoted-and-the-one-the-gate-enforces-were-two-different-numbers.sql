-- ═════════════════════════════════════════════════════════════════════════════
-- ⚠  THE "NOT APPLIED" CLAIM BELOW IS STALE. THIS MIGRATION *IS* APPLIED.
--
--    MEASURED 2026-09-04 against hrvaqgvukzxfskkcrwbt's own migration ledger,
--    `supabase_migrations.schema_migrations`, which carries a row named
--    `m523_…`. It was one of TWENTY files in this directory whose header said
--    it had never run; all twenty were in the ledger. Nobody came back to
--    update the headers after applying them.
--
--    THE EVIDENCE IS ONE-DIRECTIONAL, AND THAT IS STATED RATHER THAN GLOSSED:
--    presence in the ledger PROVES a migration ran. ABSENCE PROVES NOTHING —
--    the ledger only records migrations applied through the migration tool, and
--    m599 and m602–m605 are all applied and all absent from it, because they
--    were executed as direct SQL. So this banner is written only onto files the
--    ledger positively vouches for.
--
--    The original header is preserved below unedited. It is the record of what
--    its author believed when they wrote it, and CLAUDE.md §3 is the reason the
--    belief was wrong: "a migration that exists as a .sql file has not been
--    applied" — which is true, and cuts both ways. A file cannot tell you it
--    ran, and it cannot tell you it did not.
--
--    scripts/migration-claim-guard.ts now holds this class shut.
-- ═════════════════════════════════════════════════════════════════════════════

-- m523 — THE SEAT NUMBER A PROSPECT IS QUOTED AND THE ONE THE GATE ENFORCES
--        WERE TWO DIFFERENT NUMBERS.
-- ─────────────────────────────────────────────────────────────────────────────
-- NOT APPLIED BY THIS LANE. Lanes write migrations; only the integrator applies
-- them (CLAUDE.md §3). The application code is written to work BEFORE and AFTER
-- this file runs: lib/kernel/seat-usage.ts reads `subscription_tiers.max_agents`,
-- which already exists, and lib/kernel/tier-role-matrix.ts carries the same
-- numbers as a documented fallback — so applying this makes the CATALOGUE right,
-- it does not switch a code path on.
--
-- OWNER RULING, VERBATIM:
--   "team tier only has 5 seats for the subscription and if they need more than
--    they need to upgrade to a brokerage plan. agent tier subscription only has
--    2 seats and if they need more than they need to upgrade to a team
--    subscription. but these lower plans need to be treated like mini
--    brokerages."
--
-- ── WHAT WAS MEASURED, LIVE, BEFORE THIS FILE ────────────────────────────────
--
--   subscription_tiers.max_agents   solo_agent = 1   team = 10   brokerage = NULL
--   plan_limits.active_users        solo_agent = 3   team = 10   brokerage = 50
--   lib/kernel/tier-role-matrix.ts  solo_agent = 2   team = 5    brokerage = NULL
--
-- THREE spellings of one number and no two of them agreed, which is the §6
-- defect exactly. It was not confined to a config table either — max_agents is
-- what the tenant's own billing page prints (app/settings/billing/current-plan-card.tsx),
-- what the upgrade modal prints (app/settings/billing/upgrade-modal.tsx), and what
-- the PLATFORM VOICE RECEPTIONIST reads out to a caller asking about plans
-- (lib/voice/platform-reception.ts: "up to N agents"). So a prospect was quoted
-- 1 seat on the plan that grants 2, and 10 on the plan that grants 5, while the
-- invite gate enforced the owner's numbers. The catalogue was not merely stale;
-- it was the sales surface.
--
-- SURVIVOR: subscription_tiers.max_agents. It is the administered column — the
-- superadmin plan catalogue already edits it (app/dashboard/superadmin/plans →
-- app/actions/superadmin/plan-catalog.ts, validated as `maxAgents` in
-- lib/billing/plan-catalog.ts) — and it is the one the customer-facing surfaces
-- already read. The code literals become its fallback, not its rival.
--
-- ── THE NAME IS WRONG AND IS DELIBERATELY NOT CHANGED HERE ───────────────────
--
-- A SEAT is any working staff user (SEAT_ROLES: admin, broker, broker_owner,
-- team_lead, agent, tc, isa, compliance_officer), not only an `agent`. The right
-- name is max_seats. It is not renamed in this file because a rename lands in
-- the live schema at APPLY time while the code shipping beside it must keep
-- working against the schema as it is TODAY — a reader of a column that does not
-- exist yet fails every read, and PGRST204 refuses a write naming an absent
-- column ENTIRELY. So: the meaning is stated in a COMMENT ON COLUMN, and the
-- rename is REPORTED as a follow-up that must move the column and its six
-- readers in one commit. Renaming it silently here would be the same defect in
-- the other direction.
--
-- ── UNLIMITED ────────────────────────────────────────────────────────────────
-- NULL means unlimited. -1 also appears in the UI vocabulary (the upgrade modal
-- renders -1 as "Unlimited"), and resolveCatalogSeatLimits normalises BOTH to
-- unlimited, so neither spelling can ever be compared against a seat count as a
-- literal and refuse every add on the biggest plan.

BEGIN;

-- ── 1. The catalogue tells the truth about seats ─────────────────────────────
-- solo_agent 1 → 2 and team 10 → 5 are the owner's numbers. brokerage and
-- multi_location are already NULL (unlimited) and are asserted, not rewritten.

UPDATE public.subscription_tiers SET max_agents = 2 WHERE tier_name = 'solo_agent';
UPDATE public.subscription_tiers SET max_agents = 5 WHERE tier_name = 'team';

COMMENT ON COLUMN public.subscription_tiers.max_agents IS
  'SEAT cap for the tier: the number of WORKING STAFF USERS (admin, broker, broker_owner, team_lead, agent, tc, isa, compliance_officer) the subscription includes. NULL or -1 = unlimited. NOT restricted to the agent role despite the column name — the rename to max_seats is pending. Contacts, lenders, vendors and the AI-ISA system actor are tenant-scoped but are NOT staff and consume NO seat. Owner ruling: solo_agent = 2, team = 5, and needing more is an UPGRADE (solo -> team -> brokerage), not a paid extra seat. Read by lib/kernel/seat-usage.ts resolveCatalogSeatLimits; enforced by seatGate on every add path.';

-- ── 2. The third spelling, aligned rather than left to drift ─────────────────
-- plan_limits.active_users is the USAGE-METER limit the tenant's usage overview
-- prints (app/actions/usage-overview.ts labels it "Active users"). It is not the
-- enforcement gate — seatGate is — but leaving it at 3 and 10 keeps a tenant
-- reading a fourth number for the same fact. Aligned to the same seat caps;
-- -1 is this table's spelling of unlimited and is already correct on
-- multi_location.

UPDATE public.plan_limits SET limit_value = 2, updated_at = now()
  WHERE plan_tier = 'solo_agent' AND metric = 'active_users';
UPDATE public.plan_limits SET limit_value = 5, updated_at = now()
  WHERE plan_tier = 'team' AND metric = 'active_users';

-- brokerage keeps its own number (50) DELIBERATELY: the tier is unlimited by the
-- seat ruling, and plan_limits.active_users on that tier is a metering ceiling
-- for the usage report, not a cap the gate reads. Flagged for the owner rather
-- than changed — "unlimited" and "the report warns past 50" are not obviously
-- the same decision, and this lane will not guess which one they meant.

-- ── 3. POSTCONDITIONS — a data migration that cannot fail is not verified ────

DO $$
DECLARE
  v_solo int;
  v_team int;
  v_brokerage int;
  v_multi int;
  v_limits int;
BEGIN
  SELECT max_agents INTO v_solo      FROM public.subscription_tiers WHERE tier_name = 'solo_agent';
  SELECT max_agents INTO v_team      FROM public.subscription_tiers WHERE tier_name = 'team';
  SELECT max_agents INTO v_brokerage FROM public.subscription_tiers WHERE tier_name = 'brokerage';
  SELECT max_agents INTO v_multi     FROM public.subscription_tiers WHERE tier_name = 'multi_location';

  IF v_solo IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'm523: solo_agent seat cap is %, expected 2', v_solo;
  END IF;
  IF v_team IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'm523: team seat cap is %, expected 5', v_team;
  END IF;
  -- The two unlimited tiers are ASSERTED, not written: if either has acquired a
  -- number since, that is a product decision this file must not silently undo.
  IF v_brokerage IS NOT NULL AND v_brokerage >= 0 THEN
    RAISE EXCEPTION 'm523: brokerage seat cap is % — expected unlimited (NULL/-1). Resolve with the owner before applying.', v_brokerage;
  END IF;
  IF v_multi IS NOT NULL AND v_multi >= 0 THEN
    RAISE EXCEPTION 'm523: multi_location seat cap is % — expected unlimited (NULL/-1). Resolve with the owner before applying.', v_multi;
  END IF;

  SELECT count(*) INTO v_limits
    FROM public.plan_limits
   WHERE metric = 'active_users'
     AND ((plan_tier = 'solo_agent' AND limit_value = 2)
       OR (plan_tier = 'team'       AND limit_value = 5));
  IF v_limits <> 2 THEN
    RAISE EXCEPTION 'm523: plan_limits.active_users did not land on 2/5 (matched % of 2 rows)', v_limits;
  END IF;
END $$;

COMMIT;

-- ── AFTER APPLYING ───────────────────────────────────────────────────────────
-- Nothing to regenerate: this file adds no CHECK and no column, so the
-- vocabulary cache and schema snapshot are unaffected. Re-run
--   npm run test:seat-cap
-- which reads the LIVE catalogue in its layer-3 block and asserts 2 / 5 /
-- unlimited / unlimited against the same numbers the gate enforces.
