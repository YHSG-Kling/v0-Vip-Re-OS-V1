-- m516 — AN EXPENSE WITH NO TENANT IS A ROW ITS OWN AGENT CANNOT READ.
--
-- Wave 15, lane B. Companion to the export gate added at
-- app/actions/financials.ts#exportExpensesCSV, which now pins
-- `.eq("brokerage_id", ctx.brokerageId)` the way its commissions sibling does.
-- A pinned tenant is only correct if every row HAS one, so this closes the column.
--
-- ── THE MEASUREMENT THIS MIGRATION IS BUILT ON ──────────────────────────────
--
-- Taken live against project hrvaqgvukzxfskkcrwbt on 2026-08-21, before writing
-- a single line of DDL:
--
--   SELECT count(*) FILTER (WHERE brokerage_id IS NULL) AS null_tenant,
--          count(*) AS total
--     FROM business_expenses;
--   →  null_tenant = 0,  total = 0
--
-- The table is EMPTY. Both numbers are published together because a bare "0 NULLs"
-- would read as "the defect is already fixed" when what it actually says is
-- "nothing has been written here yet". Supporting counts, same session:
--
--   agents: 5 total, 0 with a NULL brokerage_id
--   teams:  1 total, 0 with a NULL brokerage_id
--
-- WHAT THAT MEANS FOR HONESTY, stated plainly:
--   · The backfill below is a NO-OP TODAY. It closes zero existing rows because
--     there are zero rows. It is kept, not deleted, because this file is written
--     in a lane and applied by the integrator later — rows may exist by then, and
--     a backfill that runs before the NOT NULL is the only thing that keeps the
--     NOT NULL from failing at apply time.
--   · MEASURED, and this is why the backfill CAN be complete today: every agent
--     and every team currently carries a brokerage_id (agents 5/0 untenanted,
--     teams 1/0), and there are ZERO orphan agent_id values — verified directly:
--       SELECT count(*) FROM business_expenses be WHERE be.agent_id IS NOT NULL
--         AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = be.agent_id);  → 0
--     Note this is a fact about TODAY'S DATA, not about the schema:
--     agents.brokerage_id and teams.brokerage_id are both still NULLABLE, so an
--     untenanted agent can appear without any code changing.
--   · The shapes the backfill CANNOT resolve are therefore FOUR, not one:
--       (a) agent_id NULL AND team_id NULL — a brokerage-scope expense that never
--           recorded its brokerage;
--       (b) agent_id pointing at no agents row (an orphan);
--       (c) agent_id pointing at an agent whose OWN brokerage_id is NULL;
--       (d) the team_id equivalents of (b) and (c).
--     All four are live-zero today. (c) and (d) matter disproportionately because
--     they are the SILENT ones: such a row passes a naive "no agent and no team"
--     guard, is then skipped by the backfill (which requires a non-NULL tenant on
--     the agent), and reaches the NOT NULL in step 6 still NULL — the constraint
--     failure the guard exists to prevent, raised halfway through the migration.
--     Step 1 below is written as the exact negation of what steps 2-3 can fix, so
--     all four abort cleanly with a count and change NOTHING.
--
-- ── WHY THE NULL WAS A DEFECT AT ALL (the direction was being mis-stated) ───
--
-- The comment previously standing at app/actions/agents.ts claimed the live policy
-- was `(brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())` and
-- concluded a NULL-tenant row was "readable by EVERY brokerage". That policy is
-- NOT what this database runs. Read live, `business_expenses_tenant` is:
--
--   USING       (can_read_tenant_financials()
--                OR (has_brokerage_access(brokerage_id)
--                    AND can_read_agent_books(agent_id)))
--   WITH CHECK  (is_platform_admin()
--                OR (has_brokerage_access(brokerage_id)
--                    AND (is_brokerage_finance_admin()
--                         OR (agent_id IS NOT NULL
--                             AND agent_id = current_user_agent_id()))))
--
-- and public.has_brokerage_access(target) is
--   `is_platform_admin() OR (target IS NOT NULL AND target = current_user_brokerage_id())`.
--
-- A NULL brokerage_id therefore makes has_brokerage_access() FALSE for everyone
-- except platform staff. The failure is INVISIBILITY, not exposure: an agent's own
-- spend, logged against their own agent_id, silently absent from their own books,
-- their own P&L, their own deduction readiness and their own export — while still
-- readable by platform support. That is a quieter bug than a leak and a worse one
-- to diagnose, because every surface reports success over a set that is missing
-- rows. The app-side comment has been corrected in the same change as this file.
--
-- ── THE FK IS ITSELF A NULL WRITER, AND HAD TO BE DEALT WITH FIRST ─────────
--
-- Found while checking whether NOT NULL was even applicable:
--
--   business_expenses_brokerage_id_fkey
--     FOREIGN KEY (brokerage_id) REFERENCES brokerages(id) ON DELETE SET NULL
--
-- ON DELETE SET NULL is a standing instruction to Postgres to CREATE the exact
-- value this migration is about to forbid. Left alone, deleting a brokerage would
-- either be blocked by a NOT NULL violation raised from inside the cascade (a
-- confusing failure far from its cause) or, before this migration, would have
-- quietly orphaned that brokerage's entire expense ledger into the invisible state
-- described above. So the action is changed in the same transaction.
--
-- RESTRICT, not CASCADE, and that is a deliberate choice about MONEY: expenses are
-- tax material. A brokerage row being removed must not silently take a year of
-- deductible spend with it. RESTRICT turns "delete this brokerage" into an explicit
-- conversation about what happens to its books. If the platform later wants true
-- tenant erasure, the ledger is disposed of on purpose by the offboarding path,
-- not as a side effect of a foreign key.
--
-- ── THE ONE WRITER THAT WILL START FAILING, NAMED RATHER THAN DISCOVERED ────
--
-- CENSUS METHOD, so the number carries its denominator (CLAUDE.md §2):
--   grep -rnE "from\(['\"\`]business_expenses['\"\`]\)" --include=*.ts --include=*.tsx .
-- excluding node_modules → 30 call sites, of which FOUR are INSERTs (the other 26
-- are select/update/delete). Re-taken 2026-08-21. TWO earlier drafts of this
-- census were wrong and both errors are recorded because each was a live blind
-- spot, not a typo: the first listed only THREE writers (it missed the kernel
-- one), and the second counted 28 sites because it grepped only the DOUBLE-quote
-- spelling — app/dashboard/financials/expenses/page.tsx:41 writes
-- `.from('business_expenses')` with single quotes. That site is a SELECT, so the
-- writer list was unaffected, but a quote-blind grep is exactly the finder that
-- reports zero and reads as a clean bill of health.
--
--   app/actions/financials.ts:762   #logScopedExpense   stamps brokerage_id from the SESSION  ✓
--   app/actions/agents.ts:954       #addAgentExpense    stamps brokerage_id from the SESSION  ✓
--   lib/kernel/financial.ts:1147    kernel expense path stamps brokerage_id from ctx          ✓
--   services/supabaseService.ts:1175 (via app/api/financial/expenses/route.ts:53)             ✗ DOES NOT
--
-- Remaining blind spots, stated rather than implied: this finds only the
-- supabase-js builder spelling. A write through an .rpc(), a DB trigger, a raw
-- SQL string, or a table name built by concatenation would not appear. A
-- follow-up grep for the bare string `business_expenses` surfaced no such writer
-- — only comments, one PostgREST embed (app/actions/agents.ts:196) and the
-- single-quoted SELECT above — but that is a weaker instrument and is reported
-- as such. The trigger in step 5 is the backstop that does not depend on this
-- census being complete: it derives the tenant for ANY writer, counted or not.
--
-- That last one POSTs `{ ...expenseData, agent_id }` straight into
-- services/supabaseService.ts#createBusinessExpense (line 1172), which inserts on
-- the SERVICE-ROLE client. brokerage_id is whatever the request BODY happened to
-- carry — normally nothing, i.e. NULL. It is the live source of the very rows this
-- migration forbids, and it is a tenant value arriving from a request body, which
-- CLAUDE.md §4 names as the IDOR shape found repeatedly here.
--
-- That route is owned by another lane and is NOT edited from here. So this
-- migration does not merely hope it gets fixed — the trigger below DERIVES the
-- tenant so the NOT NULL cannot turn an unfixed writer into a 500 on a live POST.
-- Enforcement without a derivation would have been a constraint that closes a data
-- hole by opening an outage.
--
-- NOTE FOR FUTURE CENSUSES (CLAUDE.md §3): after this migration,
-- business_expenses.brokerage_id has a DB TRIGGER among its writers. A scan that
-- only counts application-code writers will under-read it. It is not writerless.

BEGIN;

-- ── 1 · REFUSE TO RUN IF THE BACKFILL CANNOT BE COMPLETE ────────────────────
-- The guard must be the EXACT COMPLEMENT of what steps 2-3 can fix, or it does
-- not do its job. An earlier draft asked only for rows with no agent AND no team
-- AND no tenant — which is NARROWER than step 6 requires, and would have let the
-- migration die on the ALTER it exists to protect:
--
--   a row whose agent_id points at an agent that EXISTS but is itself untenanted
--   (agents.brokerage_id IS NULL) passes that narrower guard, is then SKIPPED by
--   step 2 (which requires a.brokerage_id IS NOT NULL), and arrives at step 6
--   still NULL — a NOT NULL violation raised halfway through, which is precisely
--   the "confusing failure far from its cause" this block was written to avoid.
--
-- The same hole exists for a team_id naming an untenanted team, and for an
-- agent_id or team_id that resolves to no row at all. So the predicate below is
-- stated the only way that is actually safe: a row is unresolvable when NEITHER
-- backfill can reach it. It is mechanically the negation of steps 2 and 3.
--
-- Live today this population is empty and so is the narrower one (agents: 5
-- total / 0 untenanted; teams: 1 / 0) — the two predicates agree ONLY because no
-- untenanted agent exists. That is a property of today's data, not of the schema:
-- agents.brokerage_id is still NULLABLE, so it can stop being true without any
-- code changing. The guard is written against the schema, not against the census.
DO $$
DECLARE
  unresolvable bigint;
BEGIN
  SELECT count(*) INTO unresolvable
    FROM public.business_expenses be
   WHERE be.brokerage_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.agents a
                      WHERE a.id = be.agent_id AND a.brokerage_id IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM public.teams t
                      WHERE t.id = be.team_id  AND t.brokerage_id IS NOT NULL);

  IF unresolvable > 0 THEN
    RAISE EXCEPTION
      'm516 aborted: % business_expenses row(s) have a NULL brokerage_id that neither backfill can derive — their agent_id/team_id is absent, points at no row, or points at an agent/team that is itself untenanted. Nothing was changed. Assign these rows a brokerage explicitly (or tenant the owning agent/team), then re-run.',
      unresolvable;
  END IF;
END
$$;

-- ── 2 · BACKFILL FROM THE OWNING AGENT ──────────────────────────────────────
-- business_expenses.agent_id → agents.id (NOT users.id — the two id spaces are
-- DISJOINT, CLAUDE.md §3). agents.brokerage_id is the tenant, read directly off
-- the agents row; no hop through users is needed or wanted.
UPDATE public.business_expenses be
   SET brokerage_id = a.brokerage_id
  FROM public.agents a
 WHERE be.agent_id     = a.id
   AND be.brokerage_id IS NULL
   AND a.brokerage_id  IS NOT NULL;

-- ── 3 · BACKFILL THE TEAM-SCOPE REMAINDER FROM THE OWNING TEAM ──────────────
-- A team-scoped expense (team_id set, agent_id NULL) is the other legitimate
-- shape; teams.brokerage_id carries its tenant. Without this, step 2 alone would
-- leave those rows NULL and the ALTER in step 4 would fail.
UPDATE public.business_expenses be
   SET brokerage_id = t.brokerage_id
  FROM public.teams t
 WHERE be.team_id      = t.id
   AND be.brokerage_id IS NULL
   AND t.brokerage_id  IS NOT NULL;

-- ── 4 · STOP THE FOREIGN KEY FROM RE-CREATING THE NULL ──────────────────────
ALTER TABLE public.business_expenses
  DROP CONSTRAINT IF EXISTS business_expenses_brokerage_id_fkey;

ALTER TABLE public.business_expenses
  ADD CONSTRAINT business_expenses_brokerage_id_fkey
  FOREIGN KEY (brokerage_id) REFERENCES public.brokerages(id) ON DELETE RESTRICT;

-- ── 5 · DERIVE THE TENANT FOR ANY WRITER THAT STILL OMITS IT ────────────────
-- Fail-closed derivation, not a default: agent first, then team. A row that
-- supplies its own brokerage_id is left exactly as written — this never overrides
-- an explicit tenant, so it cannot paper over a writer that stamps the WRONG one.
CREATE OR REPLACE FUNCTION public.business_expenses_derive_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.brokerage_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.agent_id IS NOT NULL THEN
    SELECT a.brokerage_id INTO NEW.brokerage_id
      FROM public.agents a WHERE a.id = NEW.agent_id;
  END IF;

  IF NEW.brokerage_id IS NULL AND NEW.team_id IS NOT NULL THEN
    SELECT t.brokerage_id INTO NEW.brokerage_id
      FROM public.teams t WHERE t.id = NEW.team_id;
  END IF;

  IF NEW.brokerage_id IS NULL THEN
    RAISE EXCEPTION
      'business_expenses requires a brokerage_id, and none could be derived from agent_id % / team_id %. The tenant must come from the caller SESSION (see app/actions/financials.ts#logScopedExpense), never from a request body.',
      NEW.agent_id, NEW.team_id;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS business_expenses_derive_tenant_trg ON public.business_expenses;

CREATE TRIGGER business_expenses_derive_tenant_trg
  BEFORE INSERT OR UPDATE OF agent_id, team_id, brokerage_id
  ON public.business_expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.business_expenses_derive_tenant();

-- ── 6 · CLOSE THE COLUMN ────────────────────────────────────────────────────
-- Safe at apply time only because steps 1-3 ran first. On the measured live table
-- (0 rows) this is instantaneous and cannot fail.
ALTER TABLE public.business_expenses
  ALTER COLUMN brokerage_id SET NOT NULL;

COMMENT ON COLUMN public.business_expenses.brokerage_id IS
  'Tenant anchor. NOT NULL since m516 — a NULL here made the row invisible to its own agent under policy business_expenses_tenant, because has_brokerage_access(NULL) is false for every non-platform caller. Written by the caller SESSION (never a request body); derived from agents.brokerage_id / teams.brokerage_id by trigger business_expenses_derive_tenant_trg when a writer omits it.';

COMMIT;

-- ── VERIFY BEFORE APPLYING (read-only; RUN THIS, it is the apply-safety check) ─
-- Every count must be 0, or this migration will fail partway. RUN AT APPLY TIME,
-- not trusted from this file: the numbers below were 0 on 2026-08-21 against an
-- EMPTY table, and "0 because nothing exists yet" stops being true the moment
-- app/api/financial/expenses/route.ts starts writing.
--
--   SELECT
--     (SELECT count(*) FROM business_expenses
--       WHERE brokerage_id IS NULL AND agent_id IS NULL AND team_id IS NULL) AS step1_unresolvable,
--     (SELECT count(*) FROM business_expenses be
--       WHERE be.brokerage_id IS NULL
--         AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = be.agent_id AND a.brokerage_id IS NOT NULL)
--         AND NOT EXISTS (SELECT 1 FROM teams  t WHERE t.id = be.team_id  AND t.brokerage_id IS NOT NULL)
--     ) AS would_still_be_null_at_step6,
--     (SELECT count(*) FROM business_expenses be
--       WHERE be.brokerage_id IS NOT NULL
--         AND NOT EXISTS (SELECT 1 FROM brokerages b WHERE b.id = be.brokerage_id)) AS fk_violations;
--
-- MEASURED 2026-08-21: step1_unresolvable = 0, would_still_be_null_at_step6 = 0,
-- fk_violations = 0, orphan agent_id = 0. `would_still_be_null_at_step6` is the
-- one that matters most — it is the rows step 6's NOT NULL would reject, and it
-- is deliberately a WIDER net than step 1's guard: step 1 catches only rows with
-- nothing to derive from, while this also catches a row whose agent or team
-- EXISTS but is itself untenanted. Live, no such agent or team exists (agents:
-- 5 total / 0 untenanted; teams: 1 / 0), so the two agree today and could
-- diverge later.
--
-- ── VERIFY AFTER APPLYING ───────────────────────────────────────────────────
-- Expected: null_tenant = 0, is_nullable = 'NO', delete_rule = 'RESTRICT'.
--
--   SELECT count(*) FILTER (WHERE brokerage_id IS NULL) AS null_tenant,
--          count(*) AS total
--     FROM business_expenses;
--
--   SELECT is_nullable FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='business_expenses'
--      AND column_name='brokerage_id';
--
--   SELECT rc.delete_rule
--     FROM information_schema.referential_constraints rc
--    WHERE rc.constraint_name = 'business_expenses_brokerage_id_fkey';
