-- ── APPLIED LIVE 2026-11-14 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 153, lane 153A ── read back: business_expenses.location_id + tenant trigger, business_expense_allocations (12 cols, deferred balance trigger, RLS + books policy), 3 indexes
--
-- MULTI-LOCATION EXPENSES: EACH OFFICE KEEPS ITS OWN, ALL ROLL UP TO THE MAIN TENANT ONCE.
--
-- Owner ruling (2026-11-14, verbatim): "expesnses for multiple location brokerage tenants. each location takes care of
-- expenses but all can roll up to the main tenant."
--
-- WHAT EXISTS (census, live 2026-11-14, project hrvaqgvukzxfskkcrwbt, SELECT only):
--   · business_expenses: agent_id / team_id / brokerage_id / amount / expense_date / category / description / receipt_url.
--     Scope is read from which owner column is set (agent_id = an agent's book; team_id = a team's; neither = the
--     tenant's own books). There is NO office column, so an office's costs could only be booked as the whole tenant's.
--     Rows live: 0 (so nothing needs a backfill).
--   · locations: the EXISTING office scope (managing_broker_user_id, status active|archived) — reused, not re-invented.
--   · cost_allocation: NOT a survivor for this. It is the DERIVED AI-usage split (lib/finance/usage-metering.ts deletes
--     and re-inserts it per brokerage per period), so a shared-cost fact written there would be wiped by the next rollup.
--   · No other allocation table exists (live-tables census: no *alloc* table but cost_allocation).
--
-- WHAT THIS ADDS
--   1. business_expenses.location_id — the office that OWNS an expense. Only the tenant's books carry it (agent books
--      never roll up, so an agent row with an office is refused by the trigger below). The ONE writer
--      (app/actions/financials.ts logScopedExpense) stamps it after lib/finance/expense-rollup.ts authorizeBooksWrite
--      admits that office; a team row inherits its team's office.
--   2. business_expense_allocations — explicit allocation FACTS for a centrally-owned shared cost. The source expense row
--      is never copied: its original amount stays on the one row, and each active share says what part of it an office
--      (or the main office itself, location_id NULL) carries. Shares are basis points that must total exactly 10,000
--      (100%) and allocated amounts that must total the source amount to the cent — enforced HERE at commit, not only in
--      code. Re-allocating supersedes the old set (superseded_at) instead of deleting it, so history is kept.
--
-- READERS: lib/finance/expense-rollup.ts loadExpenseRollup (office totals + unallocated shared total + tenant total,
-- each source row counted once) → the brokerage financials page "Expenses by office". WRITERS: logScopedExpense
-- (location_id), allocateSharedExpense (app/actions/financials.ts → lib/finance/expense-rollup.ts allocateSharedExpenseCore).
--
-- ROLLBACK: DROP TABLE public.business_expense_allocations; DROP FUNCTION public.business_expense_allocations_balance_check();
--           DROP TRIGGER business_expenses_location_tenant_trg ON public.business_expenses;
--           DROP FUNCTION public.business_expenses_location_tenant_check();
--           then (owner SQL — DROP INDEX / DROP COLUMN) DROP INDEX public.business_expenses_location_idx;
--           ALTER TABLE public.business_expenses DROP COLUMN location_id;

BEGIN;

-- ── 1. The office that owns an expense ───────────────────────────────────────
ALTER TABLE public.business_expenses
  ADD COLUMN IF NOT EXISTS location_id uuid NULL REFERENCES public.locations(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS business_expenses_location_idx
  ON public.business_expenses (brokerage_id, location_id)
  WHERE location_id IS NOT NULL;

-- The office must be one of THIS tenant's offices, and an agent's own book never carries one (agent books do not roll
-- up to an office or to the tenant — owner rule carried in logScopedExpense).
CREATE OR REPLACE FUNCTION public.business_expenses_location_tenant_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.location_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.agent_id IS NOT NULL THEN
    RAISE EXCEPTION 'business_expenses: an agent''s own book carries no office (location_id must be null when agent_id is set)'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.locations l WHERE l.id = NEW.location_id AND l.brokerage_id = NEW.brokerage_id
  ) THEN
    RAISE EXCEPTION 'business_expenses: location % is not an office of brokerage %', NEW.location_id, NEW.brokerage_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_expenses_location_tenant_trg ON public.business_expenses;
CREATE TRIGGER business_expenses_location_tenant_trg
  BEFORE INSERT OR UPDATE OF location_id, agent_id, brokerage_id ON public.business_expenses
  FOR EACH ROW EXECUTE FUNCTION public.business_expenses_location_tenant_check();

-- ── 2. Shared-cost allocation facts ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.business_expense_allocations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id           uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE RESTRICT,
  expense_id             uuid NOT NULL REFERENCES public.business_expenses(id) ON DELETE RESTRICT,
  -- One approved rule = one set; every row of a set shares this id.
  allocation_set_id      uuid NOT NULL,
  -- NULL = the share the main office keeps centrally.
  location_id            uuid NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  share_bps              integer NOT NULL CHECK (share_bps > 0 AND share_bps <= 10000),
  allocated_amount       numeric NOT NULL,
  -- The documented approved rule, in the approver's words (e.g. "rent split by headcount, Q3").
  rule_label             text NOT NULL CHECK (length(btrim(rule_label)) > 0),
  created_by_user_id     uuid NOT NULL REFERENCES public.users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  superseded_at          timestamptz NULL,
  superseded_by_user_id  uuid NULL REFERENCES public.users(id)
);

CREATE INDEX IF NOT EXISTS business_expense_allocations_expense_idx
  ON public.business_expense_allocations (brokerage_id, expense_id)
  WHERE superseded_at IS NULL;

-- One active share per target per expense (the main office counts as one target).
CREATE UNIQUE INDEX IF NOT EXISTS business_expense_allocations_active_target_uq
  ON public.business_expense_allocations (expense_id, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE superseded_at IS NULL;

-- THE 100% RULE, at commit: an expense's ACTIVE shares total either nothing (unallocated — the whole cost stays with
-- the main office) or exactly 10,000 bps, and their amounts total the source row's amount to the cent; every share is
-- of a row in the same tenant that is a centrally-owned, non-negative tenant-books expense.
CREATE OR REPLACE FUNCTION public.business_expense_allocations_balance_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_expense_id uuid := COALESCE(NEW.expense_id, OLD.expense_id);
  v_bps        bigint;
  v_sum        numeric;
  v_rows       integer;
  v_exp        record;
BEGIN
  SELECT e.id, e.brokerage_id, e.amount, e.agent_id, e.team_id, e.location_id
    INTO v_exp FROM public.business_expenses e WHERE e.id = v_expense_id;
  SELECT COUNT(*), COALESCE(SUM(a.share_bps), 0), COALESCE(SUM(a.allocated_amount), 0)
    INTO v_rows, v_bps, v_sum
    FROM public.business_expense_allocations a
   WHERE a.expense_id = v_expense_id AND a.superseded_at IS NULL;
  IF v_rows = 0 THEN
    RETURN NULL;
  END IF;
  IF v_exp.id IS NULL THEN
    RAISE EXCEPTION 'business_expense_allocations: expense % does not exist', v_expense_id USING ERRCODE = '23503';
  END IF;
  IF v_exp.agent_id IS NOT NULL OR v_exp.team_id IS NOT NULL OR v_exp.location_id IS NOT NULL OR v_exp.amount <= 0 THEN
    RAISE EXCEPTION 'business_expense_allocations: only a centrally-owned tenant expense with a positive amount can be allocated (expense %)', v_expense_id
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.business_expense_allocations a
              WHERE a.expense_id = v_expense_id AND a.superseded_at IS NULL AND a.brokerage_id <> v_exp.brokerage_id) THEN
    RAISE EXCEPTION 'business_expense_allocations: a share names another tenant (expense %)', v_expense_id USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.business_expense_allocations a
               LEFT JOIN public.locations l ON l.id = a.location_id
              WHERE a.expense_id = v_expense_id AND a.superseded_at IS NULL AND a.location_id IS NOT NULL
                AND (l.id IS NULL OR l.brokerage_id <> v_exp.brokerage_id)) THEN
    RAISE EXCEPTION 'business_expense_allocations: a share names an office outside the tenant (expense %)', v_expense_id USING ERRCODE = '23514';
  END IF;
  IF v_bps <> 10000 THEN
    RAISE EXCEPTION 'business_expense_allocations: active shares of expense % total % bps, not 10000 (100%%)', v_expense_id, v_bps
      USING ERRCODE = '23514';
  END IF;
  IF round(v_sum, 2) <> round(v_exp.amount, 2) THEN
    RAISE EXCEPTION 'business_expense_allocations: allocated amounts of expense % total %, not the source amount %', v_expense_id, v_sum, v_exp.amount
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS business_expense_allocations_balance_trg ON public.business_expense_allocations;
CREATE CONSTRAINT TRIGGER business_expense_allocations_balance_trg
  AFTER INSERT OR UPDATE OR DELETE ON public.business_expense_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.business_expense_allocations_balance_check();

-- RLS: the books readers of the tenant (finance roster + compliance officer — m467's can_read_brokerage_books()) and
-- platform financial staff read; NOBODY writes through the API key — the one writer runs on the service client after
-- lib/finance/expense-rollup.ts has admitted the actor.
ALTER TABLE public.business_expense_allocations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS business_expense_allocations_books_read ON public.business_expense_allocations;
CREATE POLICY business_expense_allocations_books_read
  ON public.business_expense_allocations
  FOR SELECT TO authenticated
  USING (public.has_brokerage_access(brokerage_id)
         AND (public.can_read_tenant_financials() OR public.can_read_brokerage_books()));

COMMENT ON TABLE public.business_expense_allocations IS
  'Wave 153 (lane 153A, m900): allocation FACTS of one centrally-owned shared expense across offices (location_id NULL = kept by the main office). Shares total 10000 bps and the source amount exactly (deferred constraint trigger). Source row never copied; superseded sets kept as history.';
COMMENT ON COLUMN public.business_expenses.location_id IS
  'Wave 153 (lane 153A, m900): the office that owns this tenant-books expense. NULL on a tenant-books row = the main office (shareable via business_expense_allocations); always NULL on an agent''s own book.';

COMMIT;
