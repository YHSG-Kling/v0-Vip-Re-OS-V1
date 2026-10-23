-- m442 — THE SETTLEMENT RECORD GETS A TENANT, AND AN UNSTAMPED ROW STOPS BEING
--        PUBLISHED TO EVERY BROKERAGE.
--
-- m438 closed this class on `closing_disclosure_agreement`. Its two sibling
-- tables were out of that assignment's scope and still carry it, found by
-- querying the catalogue while verifying m440 rather than by trusting m438's
-- scope. Measured live before a line of this was written.
--
-- ── DEFECT 1: A ROLE TEST WITH NO TENANT TEST ────────────────────────────────
--
-- Seven policies, all `FOR ALL`, all granted TO PUBLIC, each whose ENTIRE
-- predicate is one bare `user_type` comparison:
--
--   closing_disclosure.admin_crud_delete_closing_disclosure        'admin'
--   closing_disclosure.broker_crud_closing_disclosure              'broker'
--   closing_disclosure.compliance_officer_crud_closing_disclosure  'compliance_officer'
--   cda_comparison_results.admin_crud_cda_comparison               'admin'
--   cda_comparison_results.broker_crud_cda_comparison              'broker'
--   cda_comparison_results.compliance_officer_crud_cda_comparison  'compliance_officer'
--
-- plus one read with neither a tenant NOR an ownership term:
--
--   closing_disclosure.agent_select_closing_disclosure             'agent'
--
-- A role test says WHO may act. It never says WHICH ROWS. So a broker at ONE
-- brokerage could read, alter and DELETE ANOTHER brokerage's settlement figures,
-- and every agent on the platform could read every closing disclosure that will
-- ever exist. `FOR ALL` is what makes the first sentence include DELETE: USING
-- alone governs DELETE and there is no WITH CHECK to stop it — the lesson m437
-- cost this branch.
--
-- The correctly-scoped `closing_disclosure_tenant` sitting beside them protected
-- nothing, because PERMISSIVE POLICIES OR TOGETHER. A row is visible if ANY
-- policy admits it. Adding a good policy next to a bad one changes nothing at
-- all; the bad one has to go.
--
-- ── DEFECT 2: THE NULL ESCAPE, AND IT IS THE OPPOSITE OF WHAT IT LOOKS LIKE ──
--
--   closing_disclosure_tenant  FOR ALL  TO authenticated
--     USING + WITH CHECK  ((brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id()))
--
-- This reads like "untenanted rows are hidden". It is the reverse: a NULL
-- brokerage_id satisfies the FIRST disjunct for EVERY caller of EVERY tenant, so
-- an unstamped settlement record is PUBLISHED PLATFORM-WIDE — and because the
-- policy is FOR ALL with the same expression on WITH CHECK, published on SELECT,
-- INSERT, UPDATE and DELETE alike. Anyone may also CREATE an unstamped row, which
-- is to say: create a row everybody can read.
--
-- `has_brokerage_access(NULL)` is FALSE by construction, which is why every policy
-- written since m427 anchors on it instead of on a raw comparison.
--
-- ── WHAT IS IN THE ROW ───────────────────────────────────────────────────────
--
-- The settlement record — what actually changed hands at closing. Owner ruling,
-- verbatim: "a brokerage can only have access to their own commission", and
-- "contacts, lenders and vendors do not see commission or any financials but only
-- their own".
--
-- ── NOTHING BREAKS, MEASURED NOT ASSUMED ─────────────────────────────────────
--
-- Both tables hold ZERO rows, and NEITHER HAS ANY APPLICATION READER OR WRITER.
-- Every grep hit on these names in app/ and lib/ is a `doc_type` STRING LITERAL
-- on `transaction_documents` ('closing_disclosure', 'final_closing_disclosure',
-- 'preliminary_closing_disclosure') or a display-label map — not a table read.
-- The same check m440 ran, re-run. No surface changes.
--
-- ── THE TIER IS NOT INVENTED HERE; IT IS THE PARENT'S, INHERITED ─────────────
--
-- `closing_disclosure_agreement` is already correctly tiered by m433/m438, so
-- this adopts its predicate rather than authoring a second answer to the same
-- question. That is the point of the exercise: one rule per question.
--
--   parent SELECT: can_read_tenant_financials()
--                  OR (has_brokerage_access(brokerage_id) AND can_read_agent_books(agent_id))
--   parent WRITE : is_platform_admin()
--                  OR (has_brokerage_access(brokerage_id)
--                      AND (is_brokerage_admin() OR agent_id = current_user_agent_id()))
--
-- ── AND THE TWO CAPABILITIES m440 REMOVED COME BACK, THROUGH THE COLUMN THAT
--    ACTUALLY CARRIES THEM ───────────────────────────────────────────────────
--
-- m440 dropped `title_agent_select_closing_disclosure` and
-- `title_agent_create_closing_disclosure` because they gated on a `user_type`
-- m307 removed, so they granted nothing to anybody. Dropping a dead PREDICATE is
-- right; losing the CAPABILITY it was reaching for is not — the title company
-- filing the settlement statement is a real party to a real closing.
--
-- `closing_disclosure.title_agent_id` is a REAL COLUMN with a REAL FK to
-- users(id). So the capability is expressed through the column the schema already
-- declares, and needs no role vocabulary at all: `title_agent_id = auth.uid()`.
-- That is strictly better than what was dropped — it is per-row rather than
-- per-role, so it cannot leak one title company's closing to another's.
--
-- The vendor route m440's own comment named is honoured too:
-- `vendor_has_transaction_access(transaction_id)` already exists and is already
-- how a vendor (a title company IS `vendors.category = 'title'`) reaches a deal.
-- Reused, not reinvented.
--
-- ── PER-COMMAND, NOT `FOR ALL` ───────────────────────────────────────────────
--
-- Every policy below is per-command. m437 had to bolt RESTRICTIVE DELETE guards
-- onto four `FOR ALL` tables precisely because a read-shaped USING on a FOR ALL
-- policy IS a delete grant. Splitting at the start costs one extra CREATE and
-- removes the whole failure mode. Verified first that no guard and no bootstrap
-- script pins any of the names being dropped.

-- ═════════════════════════════════════════════════════════════════════════════
-- A. closing_disclosure
-- ═════════════════════════════════════════════════════════════════════════════

do $$
declare
  read_expr constant text :=
    'public.can_read_tenant_financials()
     or (public.has_brokerage_access(brokerage_id) and public.can_read_brokerage_books())
     or (public.has_brokerage_access(brokerage_id)
         and transaction_id is not null
         and exists (select 1 from public.transactions t
                      where t.id = closing_disclosure.transaction_id
                        and (   public.can_read_agent_books(t.agent_id)
                             or public.can_read_agent_books(t.seller_agent_id)
                             or public.can_read_agent_books(t.buyer_agent_id))))
     or (title_agent_id is not null and title_agent_id = auth.uid())
     or (transaction_id is not null and public.vendor_has_transaction_access(transaction_id))';

  write_expr constant text :=
    'public.is_platform_admin()
     or (public.has_brokerage_access(brokerage_id)
         and (public.is_brokerage_admin() or public.is_compliance_officer_role()))
     or (title_agent_id is not null and title_agent_id = auth.uid())';

  dead text[] := array[
    'admin_crud_delete_closing_disclosure',
    'broker_crud_closing_disclosure',
    'compliance_officer_crud_closing_disclosure',
    'agent_select_closing_disclosure',
    'closing_disclosure_tenant'
  ];
  nm   text;
  pred text;
  n    int := 0;
begin
  -- Refuse to drop a policy that has since acquired a tenant term. If somebody
  -- repaired one of these between the audit and the apply, this stops rather than
  -- deleting their work — m438's guard, transplanted, with the test aimed at the
  -- defect being removed. `closing_disclosure_tenant` is exempt from the check
  -- because it is being replaced BECAUSE of its tenant term, not for lacking one.
  foreach nm in array dead loop
    select regexp_replace(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
                          coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), '\s+', ' ', 'g')
      into pred
      from pg_policy p
      join pg_class     c  on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relname = 'closing_disclosure' and p.polname = nm;

    if pred is null then
      raise notice 'm442: closing_disclosure.% is already gone.', nm;
      continue;
    end if;

    if nm <> 'closing_disclosure_tenant'
       and pred ~ '(has_brokerage_access|current_user_brokerage_id|user_brokerage_ids)' then
      raise exception
        'm442: closing_disclosure.% has acquired a tenant term since this was written (%). It had none — refusing to delete somebody else''s repair. Re-audit.', nm, pred;
    end if;

    execute format('drop policy %I on public.closing_disclosure', nm);
    n := n + 1;
  end loop;

  execute format('create policy closing_disclosure_tenant_select on public.closing_disclosure
                  for select to authenticated using (%s)', read_expr);
  execute format('create policy closing_disclosure_tenant_insert on public.closing_disclosure
                  for insert to authenticated with check (%s)', write_expr);
  execute format('create policy closing_disclosure_tenant_update on public.closing_disclosure
                  for update to authenticated using (%s) with check (%s)', write_expr, write_expr);
  execute format('create policy closing_disclosure_tenant_delete on public.closing_disclosure
                  for delete to authenticated using (%s)', write_expr);

  raise notice 'm442: closing_disclosure — dropped % tenant-free/NULL-escaping policies, created 4 per-command policies on the parent CDA''s tier. The title company keeps its access through title_agent_id and vendor_has_transaction_access(), which is per-ROW rather than per-role.', n;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- B. cda_comparison_results — ANCHORED THROUGH ITS PARENT, BECAUSE IT HAS NO
--    TENANT COLUMN OF ITS OWN
-- ═════════════════════════════════════════════════════════════════════════════
--
-- This table has NO brokerage_id. Its columns are id, cda_id, hiring_agreement_id,
-- differences, ai_summary, created_at — and `cda_id` carries a real FK to
-- `closing_disclosure_agreement`. So the tenant is reached THROUGH THE PARENT, and
-- that is not a workaround: it is exactly what this table's own surviving policy
-- `agent_select_own_cda_comparison` already does. The shape is inherited from the
-- row's own foreign key rather than a column being added to carry a copy of the
-- parent's tenant, which would immediately be a second place the truth lives.
--
-- The predicate below IS the parent's SELECT predicate, applied through cda_id.
-- If the parent's tier is later corrected, this follows it, because it defers to
-- the same helpers rather than restating them.
--
-- A comparison row whose cda_id is NULL, or whose parent is gone, resolves to NO
-- ROWS — the EXISTS is false. Fail-closed, and the right direction: an orphaned
-- comparison of two settlement records belongs to nobody, so nobody reads it.

do $$
declare
  read_expr constant text :=
    'exists (select 1 from public.closing_disclosure_agreement cda
              where cda.id = cda_comparison_results.cda_id
                and (   public.can_read_tenant_financials()
                     or (public.has_brokerage_access(cda.brokerage_id)
                         and public.can_read_agent_books(cda.agent_id))))';

  write_expr constant text :=
    'exists (select 1 from public.closing_disclosure_agreement cda
              where cda.id = cda_comparison_results.cda_id
                and (   public.is_platform_admin()
                     or (public.has_brokerage_access(cda.brokerage_id)
                         and (   public.is_brokerage_admin()
                              or public.is_compliance_officer_role()
                              or (cda.agent_id is not null
                                  and cda.agent_id = public.current_user_agent_id())))))';

  dead text[] := array[
    'admin_crud_cda_comparison',
    'broker_crud_cda_comparison',
    'compliance_officer_crud_cda_comparison'
  ];
  nm   text;
  pred text;
  n    int := 0;
begin
  foreach nm in array dead loop
    select regexp_replace(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
                          coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), '\s+', ' ', 'g')
      into pred
      from pg_policy p
      join pg_class     c  on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relname = 'cda_comparison_results' and p.polname = nm;

    if pred is null then
      raise notice 'm442: cda_comparison_results.% is already gone.', nm;
      continue;
    end if;

    if pred ~ '(has_brokerage_access|current_user_brokerage_id|user_brokerage_ids|closing_disclosure_agreement)' then
      raise exception
        'm442: cda_comparison_results.% has acquired a tenant anchor since this was written (%). Refusing to delete somebody else''s repair. Re-audit.', nm, pred;
    end if;

    execute format('drop policy %I on public.cda_comparison_results', nm);
    n := n + 1;
  end loop;

  execute format('create policy cda_comparison_tenant_select on public.cda_comparison_results
                  for select to authenticated using (%s)', read_expr);
  execute format('create policy cda_comparison_tenant_insert on public.cda_comparison_results
                  for insert to authenticated with check (%s)', write_expr);
  execute format('create policy cda_comparison_tenant_update on public.cda_comparison_results
                  for update to authenticated using (%s) with check (%s)', write_expr, write_expr);
  execute format('create policy cda_comparison_tenant_delete on public.cda_comparison_results
                  for delete to authenticated using (%s)', write_expr);

  -- The agent's own-row read is KEPT, not replaced: it resolves through
  -- closing_disclosure_agreement.agent_id = current_user_agent_id(), which m390
  -- installed deliberately to stop an agents.id being compared to a users.id. It
  -- is only moved off PUBLIC, so it stops being evaluated for `anon`. Its safety
  -- today rests on current_user_agent_id() returning NULL for an anonymous
  -- caller — i.e. on a function's internals rather than on the grant. m431 §C
  -- narrowed commission_splits for exactly this reason.
  alter policy agent_select_own_cda_comparison on public.cda_comparison_results to authenticated;

  raise notice 'm442: cda_comparison_results — dropped % tenant-free policies, created 4 per-command policies anchored through cda_id to the parent CDA''s own tier, and moved the agent''s own-row read off PUBLIC.', n;
end $$;
