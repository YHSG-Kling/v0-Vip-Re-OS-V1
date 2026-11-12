-- ── APPLIED LIVE 2026-10-19 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — the MCP accepted ALTER TABLE … DROP CONSTRAINT (only DROP INDEX/COLUMN are held); guard DO block passed (0 superadmin rows) ──
--
-- m782 — users_user_type_check without 'superadmin' (wave 142, lane 142A; owner, 2026-10-18: "review
-- migration with constraint drop on dead inline superadmin user_type"). The policy half is m781.
--
-- WHY. Platform staff live in users.platform_role and nowhere else (owner ruling 2026-10-14; m780 aligned
-- public.is_platform_admin() / is_platform_staff(); the app resolvers never read user_type as authority).
-- 'superadmin' is still a STORABLE users.user_type value, so the fallback shape the owner ruled out can
-- be re-created by one INSERT. Removing it from the CHECK makes every legacy arm — the 37 m781 rewrites
-- and the app-side spellings the platform-discriminator guard freezes — provably unreachable at the
-- schema level, not merely dead on today's rows.
--
-- EVIDENCE (measured live 2026-10-18): 0 rows in public.users carry user_type='superadmin'. The one
-- superadmin is (user_type='admin', platform_role='superadmin'), which this CHECK keeps storable. The
-- platform-staff CRUD (app/actions/superadmin/platform-staff.ts roleColumns) writes admin / admin /
-- support / system — never 'superadmin'.
--
-- 'support' STAYS STORABLE, with the evidence stated: 0 live rows carry user_type='support' with a NULL
-- platform_role (a tenant-typed support seat), and the only live writer of user_type='support' is the
-- platform-staff CRUD, which writes it beside platform_role='support'. The tenant seat matrix
-- (lib/kernel/tier-role-matrix.ts roleRefusalReason) refuses 'support' as a workspace seat, and since
-- wave 142 (lane 142A) a user_type of 'support' never widens support-queue scope past its own brokerage
-- (lib/support/ticket-scope.ts). Nothing in the roster says the value must go; it is a vocabulary the
-- staff CRUD depends on, so it is kept.
--
-- ONE STATEMENT, ATOMIC (wave-138 lesson): the DROP and the ADD ride one ALTER TABLE, so the column is
-- never unconstrained between them. The standalone DROP CONSTRAINT is what the Supabase MCP holds for the
-- owner's confirmation — hence the SQL-editor stamp above.
--
-- PRE-CHECK FIRST: a row typed 'superadmin' would make ADD CONSTRAINT fail with 23514 anyway; the block
-- below says WHY in a sentence instead, and names the repoint (user_type='admin' + platform_role).
--
-- AFTER APPLYING, the integrator:
--   1. verifies:  SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'users_user_type_check';
--                 SELECT count(*) FROM public.users WHERE user_type = 'superadmin';   -- 0
--   2. regenerates scripts/check-vocabularies.ts (users.user_type loses 'superadmin' — 13 values) so
--      test:check-vocabulary and test:role-vocabulary read the live CHECK;
--   3. retires the cause-2 entry this file adds to scripts/vocabulary-snapshot-baseline.json
--      ("users.user_type (m782-…: snapshot missing [], extra [superadmin])") — it dissolves once the
--      snapshot agrees with the file;
--   4. flips this header to APPLIED and lowers scripts/migration-claim-guard.ts NOT_APPLIED_BASELINE.

DO $$
DECLARE
  n_super int;
BEGIN
  SELECT count(*) INTO n_super FROM public.users WHERE user_type = 'superadmin';
  IF n_super > 0 THEN
    RAISE EXCEPTION 'm782 refused: % public.users row(s) still carry user_type = ''superadmin'' — repoint each to user_type = ''admin'' with platform_role = ''superadmin'' (the live staff shape) before tightening the CHECK', n_super;
  END IF;
END $$;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_user_type_check,
  ADD CONSTRAINT users_user_type_check
  CHECK (user_type = ANY (ARRAY['admin'::text, 'agent'::text, 'broker'::text, 'broker_admin'::text, 'broker_owner'::text, 'compliance_officer'::text, 'contact'::text, 'isa'::text, 'support'::text, 'system'::text, 'tc'::text, 'team_lead'::text, 'vendor'::text]));
