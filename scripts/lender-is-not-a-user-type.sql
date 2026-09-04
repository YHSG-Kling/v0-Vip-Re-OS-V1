-- scripts/lender-is-not-a-user-type.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- ✅ APPLIED LIVE 2026-09-04 to hrvaqgvukzxfskkcrwbt by the integrator.
--    (CLAUDE.md §3: lanes write migrations, the integrator applies them.)
--
--    RESULT, verified by re-reading pg_constraint afterwards rather than by
--    trusting the statement: the CHECK now admits FOURTEEN values, 'lender' is
--    gone from it, and `select count(*) from users where user_type='lender'`
--    returns 0.
--
--    THE TWO ROWS, INSPECTED BEFORE THE UPDATE rather than counted. Both are
--    seed identities — lender@yourbrokerage.com (holding a `lender` grant in
--    user_role_assignments) and lender@vip.demo (holding none) — and NEITHER has
--    a `vendors` row. So the repoint takes nothing away: as vendors with no
--    vendor record they still see nothing, exactly as they saw nothing as
--    lenders, and the ruling's real effect is on the seats created from here on.
--    Creating vendor records for two demo seats would be inventing data, so it
--    was not done; it is recorded instead, because "the surface is on now" would
--    be the wrong claim for these two rows specifically.
--
--    THE VOCABULARY CACHE WAS REGENERATED in the same step, as this header
--    required — scripts/check-vocabularies.ts rebuilt from all 913 live
--    single-column CHECKs (435 tables, 767 columns), with 'lender' the only
--    membership change. test:check-vocabulary is green and RETIRED 17 in-memory
--    baseline entries in the process; test:seat-display 142, test:identity-class
--    113, test:vendor-categories 148, test:role-union-nav 57 and
--    test:schema-cache-drift 43 are green too.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- OWNER RULING, 2026-09-04, verbatim:
--
--     "lender is not a user type, it is a vendor category."
--
-- ── WHY THIS IS A FIX AND NOT A RENAME ──────────────────────────────────────
--
-- public.transactions carries FIVE SELECT policies. The external-partner one is
--
--     current_user_type() = 'vendor' AND vendor_has_transaction_access(id)
--
-- A user whose user_type is 'lender' matches NONE of the five. supabase-js
-- RESOLVES a refusal (CLAUDE.md §3), so every lender-facing read came back as a
-- successful, empty array — app/lender/pipeline/page.tsx rendered a permanent
-- "0 active loans" for its entire life, and nothing anywhere logged a denial.
-- Typed correctly, as a VENDOR whose vendors.category is 'lender', the SAME
-- existing policy admits them. This ruling turns a dead surface back on.
--
-- ── THE TWO SPELLINGS, AND WHICH ONE SURVIVES (CLAUDE.md §6) ────────────────
--
--   SURVIVOR   vendors.category = 'lender'   (live CHECK, 40 values, also
--              carries 'refinance_lender' and 'title'). Resolved by
--              lib/kernel/lender-linkage.ts (isLenderVendorCategory,
--              lenderVendorForUser, LENDER_BENCH_CATEGORIES) and gated by
--              lib/kernel/portal-auth.ts (requireLenderVendorActor). The header
--              of lender-linkage.ts has said "LENDERS ARE VENDORS" since l16.
--
--   DUPLICATE  users.user_type = 'lender'    ← dropped here.
--
-- This finishes work l16-s01-retire-lender-identity-rail.sql explicitly deferred:
-- "the users.user_type CHECK still permits 'lender' (legacy rows exist) …
--  migrating any residual 'lender' users onto the vendor rail is a separate data
--  task." This is that task.
--
-- ── PRECEDENT: THE IDENTICAL CASE, ALREADY DECIDED ──────────────────────────
--
-- supabase/migrations/m307-title-agent-is-not-a-user-type.sql did exactly this
-- for 'title_agent', for exactly this reason ("a title company is a VENDOR …
-- admitting it here let one be created where no vendor surface could see it").
-- m307 had zero rows to move; this one has two, so step 1 exists.
--
-- ── title_agent: NOT TOUCHED, AND WHY (asked for by the brief) ──────────────
--
-- The census found the SAME SHAPE but NOT the same drift. users_user_type_check
-- does not admit 'title_agent' at all — m307 removed it, and
-- scripts/seat-display-simulator.ts:336 already asserts that it stays removed.
-- So there is no CHECK change and no data to repoint for title. What WAS stale
-- was the SOURCE: lib/auth/resolve-user-role.ts still listed 'title_agent' in a
-- union whose own comment calls it "the raw users.user_type COLUMN vocabulary".
-- That is fixed in code in this same change; no SQL is needed or included.

BEGIN;

-- ── STEP 1 · REPOINT THE DRIFTED ROWS ───────────────────────────────────────
--
-- MEASURED by the integrator before this file was written: 2 live rows carry
-- users.user_type = 'lender'. They become 'vendor' — the seat they should always
-- have held. This does NOT invent their lender-ness: that is carried by their
-- vendors row (category 'lender') and the user_role_assignments grant that links
-- them to it, neither of which this migration touches.
--
-- The count is asserted, not assumed. A silent UPDATE of 0 rows and a silent
-- UPDATE of 200 look identical in psql output, and one of them means the census
-- was measuring a different database.
DO $$
DECLARE moved int;
BEGIN
  UPDATE public.users SET user_type = 'vendor' WHERE user_type = 'lender';
  GET DIAGNOSTICS moved = ROW_COUNT;
  RAISE NOTICE 'lender-is-not-a-user-type: repointed % users.user_type lender -> vendor', moved;
  IF moved > 20 THEN
    RAISE EXCEPTION 'aborted: % rows carried user_type=lender, far more than the 2 the census measured. Re-measure before applying.', moved;
  END IF;
END $$;

-- ── STEP 2 · REFUSE TO PROCEED IF ANY ROW STILL CARRIES IT ──────────────────
--
-- Same shape as m307. ADD CONSTRAINT would fail anyway, but it would fail with a
-- constraint-violation string instead of a sentence naming the fix.
DO $$
DECLARE offending int;
BEGIN
  SELECT count(*) INTO offending FROM public.users WHERE user_type = 'lender';
  IF offending > 0 THEN
    RAISE EXCEPTION 'aborted: % users still carry user_type=lender. Convert them to vendors (vendors.category=lender) first.', offending;
  END IF;
END $$;

-- ── STEP 3 · DROP 'lender' FROM THE CHECK ───────────────────────────────────
--
-- The array below is the LIVE vocabulary (scripts/check-vocabularies.ts:1556,
-- generated 2026-09-01) MINUS 'lender' — fifteen values become fourteen. Note it
-- is NOT m307's array: 'broker_admin' joined the CHECK after m307 (m530, owner
-- ruling 2026-08-22, "a broker admin is a user type with differnt permission
-- roles"), so retyping m307's list here would silently REVOKE it. Derived from
-- the cache, not from the last migration that touched this constraint.
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_user_type_check;

ALTER TABLE public.users ADD CONSTRAINT users_user_type_check CHECK (
  user_type = ANY (ARRAY[
    'admin', 'agent', 'broker', 'broker_admin', 'broker_owner',
    'compliance_officer', 'contact', 'isa', 'superadmin', 'support',
    'system', 'tc', 'team_lead', 'vendor'
  ])
);

COMMENT ON COLUMN public.users.user_type IS
  'The user''s PRIMARY type — the SEAT. A user may hold additional roles in user_role_assignments; permissions consider both, and a seat counts the PERSON once regardless of how many roles they hold (lib/kernel/seat-usage.ts). ''title_agent'' was removed in m307 and ''lender'' here: both are VENDOR CATEGORIES (vendors.category ''title'' / ''lender''), not OS user types. Admitting them here created users no vendor surface could see AND that no transactions RLS policy admitted — public.transactions'' external-partner policy reads current_user_type() = ''vendor'', so a ''lender'' matched none of the five and every lender-facing read came back silently empty. Lender identity is resolved from the vendor record: lib/kernel/lender-linkage.ts.';

COMMIT;

-- ── WHAT DELIBERATELY DOES NOT CHANGE ───────────────────────────────────────
--
--   · user_role_assignments.role — has NO CHECK, and 'lender' grants are LIVE
--     and CORRECT there: that row is what carries the vendor_id linking the
--     person to their lender vendor. It is the permission vocabulary, not the
--     seat, and lib/security/types.ts keeps 'lender' as a canonical role for the
--     same reason it keeps 'title_agent'.
--   · vendor_assignments.assignment_type — 'lender' is a live, correct value
--     there (which vendor lane a vendor was assigned on).
--   · transaction_lenders — the financing capability layer, untouched since l16.
--   · vendors.category — the SURVIVOR. Nothing about it changes.
