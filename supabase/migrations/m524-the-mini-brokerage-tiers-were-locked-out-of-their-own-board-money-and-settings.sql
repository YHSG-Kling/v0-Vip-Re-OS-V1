-- ═════════════════════════════════════════════════════════════════════════════
-- ⚠  THE "NOT APPLIED" CLAIM BELOW IS STALE. THIS MIGRATION *IS* APPLIED.
--
--    MEASURED 2026-09-04 against hrvaqgvukzxfskkcrwbt's own migration ledger,
--    `supabase_migrations.schema_migrations`, which carries a row named
--    `m524_…`. It was one of TWENTY files in this directory whose header said
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

-- m524 — THE MINI-BROKERAGE TIERS WERE LOCKED OUT OF THEIR OWN BOARD, THEIR OWN
--        MONEY AND THEIR OWN SETTINGS.
-- ─────────────────────────────────────────────────────────────────────────────
-- NOT APPLIED BY THIS LANE (CLAUDE.md §3). Data-only; no DDL, no CHECK, so
-- nothing needs regenerating afterwards.
--
-- OWNER RULING (the half of the seat ruling that is easy to miss):
--   "…but these lower plans need to be treated like mini brokerages."
--
-- A seat CAP is not a capability cap. Within their 2 and 5 seats, solo_agent and
-- team are brokerages: their own board, their own money, their own branding,
-- their own user management. The catalogue said otherwise.
--
-- ── MEASURED LIVE, before this file (feature_flags, enabled + not deprecated) ─
--
--   feature_key            solo  team  brokerage  multi
--   brokerage_dashboard      f     f       t        t     ← their own BOARD
--   commission_reports       f     f       t        t     ← their own MONEY
--   compliance_reports       f     f       t        t     ← their own COMPLIANCE
--   brokerage_settings       f     f       t        t     ← their own SETTINGS/BRANDING
--
-- Those four are the ruling almost word for word, denied to exactly the two
-- tiers the ruling is about. They are flipped on here.
--
-- ── WHAT THIS DOES AND DOES NOT CHANGE TODAY ─────────────────────────────────
--
-- Stated plainly rather than overclaimed: NO application code passes any of
-- these four keys to canAccessFeature() today (grepped across app/ and lib/ —
-- every `brokerage_settings` hit in the tree is the TABLE of that name, not the
-- feature key). So these rows currently gate nothing at runtime; they are the
-- catalogue the god console and the feature-governance page display, and the
-- matrix any future wiring of those surfaces would read. Fixing them is fixing
-- the stated policy before something enforces it — which is the cheap moment.
--
-- A SECOND, LOUDER DEFECT IS REPORTED AND NOT FIXED HERE: the tier those columns
-- are indexed by is resolved in lib/kernel/0.1-feature-access.ts
-- `mapUserTypeToTier` from the caller's USER_TYPE and team membership — "has a
-- brokerage but no team ⇒ brokerage tier" — not from `brokerages.plan_tier`, the
-- subscription. So a solo tenant's admin is already resolved as tier
-- `brokerage` and passes these gates for the wrong reason. It errs OPEN, so
-- nothing is locked out by it, but it means the tier columns are not currently
-- being asked about the tier anybody is actually billed for. That is a
-- correctness fix with its own blast radius (every canAccessFeature caller) and
-- it needs its own lane, not a side effect of a seat ruling.
--
-- ── NOT CHANGED, DELIBERATELY — these are judgement calls, not clear-cut ─────
--
--   feature_key                solo  team   why it is left alone
--   team_dashboard              f     t     a solo tenant has no team
--   team_management             f     t     same
--   campaign_roi_dashboard      f     t     reporting depth, plausibly a scale upsell
--   custom_reports              f     t     same
--   competitor_monitor          f     t     marketing scale feature
--   omnipresence_repurposer     f     t     marketing scale feature
--   provider_override           f     t     infra/credential control
--
-- Every one of those is denied to SOLO ONLY, so the team tier — the one the
-- owner's sentence is most about — already has them. Whether a 2-seat tenant
-- should also get custom reports is a pricing decision, and this lane will not
-- make it silently. REPORTED FOR THE OWNER.

BEGIN;

UPDATE public.feature_flags
   SET solo_agent_access = true,
       team_access       = true,
       updated_at        = now()
 WHERE feature_key IN (
         'brokerage_dashboard',   -- their own board
         'commission_reports',    -- their own money
         'compliance_reports',    -- their own compliance
         'brokerage_settings'     -- their own settings + branding
       );

-- POSTCONDITION — an UPDATE that matched nothing must not read as success.
DO $$
DECLARE v_open int; v_rows int;
BEGIN
  SELECT count(*) INTO v_rows FROM public.feature_flags
   WHERE feature_key IN ('brokerage_dashboard','commission_reports','compliance_reports','brokerage_settings');
  IF v_rows <> 4 THEN
    RAISE EXCEPTION 'm524: expected 4 catalogue rows, found % — the feature keys moved; re-derive before applying', v_rows;
  END IF;

  SELECT count(*) INTO v_open FROM public.feature_flags
   WHERE feature_key IN ('brokerage_dashboard','commission_reports','compliance_reports','brokerage_settings')
     AND solo_agent_access AND team_access;
  IF v_open <> 4 THEN
    RAISE EXCEPTION 'm524: only % of 4 mini-brokerage capabilities are open to solo+team', v_open;
  END IF;
END $$;

COMMIT;
