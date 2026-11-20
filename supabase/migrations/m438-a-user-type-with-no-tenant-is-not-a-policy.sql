-- m438 — a bare `user_type` test is not a policy: it is a global grant.
--
-- ── WHAT WAS ACTUALLY THERE ──────────────────────────────────────────────────
--
-- public.closing_disclosure_agreement is the settlement record. It states
-- gross_commission, agent_net and brokerage_net for a CLOSED deal — the
-- instruction the closing agent disburses money from. It carried FOUR `FOR ALL`
-- policies whose ENTIRE predicate, on BOTH the USING and the WITH CHECK side,
-- was a user_type test with no tenant term at all:
--
--   broker_crud_cda              (select user_type from users where id=auth.uid()) = 'broker'
--   admin_crud_delete_cda        ...                                              = 'admin'
--   compliance_officer_crud_cda  ...                                              = 'compliance_officer'
--   agent_crud_own_cda           agent_id = current_user_agent_id()
--                                OR ... = ANY('{compliance_officer,broker,admin}')
--   title_agent_select_cda       ...                                              = 'title_agent'   (SELECT)
--
-- `FOR ALL` covers SELECT, INSERT, UPDATE and DELETE. Permissive policies OR
-- together, so the correctly-scoped closing_disclosure_agreement_tenant_* set
-- beside them — and the tier predicate m433 applied to its SELECT — subtracted
-- NOTHING. Measured on a live rolled-back fixture with one CDA in each of two
-- brokerages, BEFORE this migration:
--
--   PRINCIPAL             seesA  seesB     delA     updB
--   broker(A)                 1      1        1        1
--   broker(B) CROSS           1      1        1        1     <-- other tenant's settlement
--   admin(B)                  1      1        1        1
--   compliance_off(B)         1      1        1        1
--   agent(A) owns row         1      0        1        0
--   agent(B)                  0      1        0        1
--   contact(A)                0      0        0        0     (m433 holding)
--   platform support          1      1        0        0     (m437 holding: reads, no pen)
--
-- A broker at brokerage B could read, rewrite and DELETE brokerage A's closing
-- disclosure. `delA = 1` is not a theoretical exposure; it is a row-count.
--
-- ── WHY DROP RATHER THAN REWRITE ─────────────────────────────────────────────
--
-- Coverage was proved per role BEFORE deleting anything, against the four
-- surfaces that read this table (app/actions/cda-portal-list.ts — the compliance
-- review queue; app/actions/cda-portal.ts — the whole draft→submit→approve→
-- broker-sign→send-to-title rail; app/actions/cda-template-field-actions.ts; and
-- app/dashboard/transactions/[id]/cda/{page.tsx,cda-workflow-client.tsx} — the
-- agent surface). Every one of them uses the SESSION client, so RLS is the real
-- gate, not a formality.
--
-- READ. closing_disclosure_agreement_tenant_select is
--   can_read_tenant_financials() OR (has_brokerage_access(brokerage_id)
--                                    AND can_read_agent_books(agent_id))
-- and can_read_agent_books() ORs in can_read_brokerage_books(), whose positive
-- roster is admin, broker, broker_owner, broker_admin, compliance_officer. So
-- every role the four dropped policies admitted for SELECT — broker, admin,
-- compliance_officer, the owning agent — is already admitted by the tier policy,
-- within its own tenant. The compliance queue's own gate
-- (COMPLIANCE_ROLES = compliance_officer, admin, broker, broker_admin,
-- superadmin) is a strict subset of that roster. Nothing to merge on the read
-- side; the four were pure redundancy pointed at every tenant.
--
-- WRITE. The tier INSERT/UPDATE/DELETE policies are
--   is_platform_admin() OR (has_brokerage_access(brokerage_id)
--                           AND (is_brokerage_admin() OR agent owns the row))
-- and is_brokerage_admin() is admin/broker/broker_owner. That leaves exactly ONE
-- capability the dropped policies carried and the tier set does not:
-- **compliance_officer writes**. It is load-bearing — approveCdaAction,
-- requestCdaChangesAction, manualOverrideCdaAction, closeCdaAction,
-- runSignatureCheckForCdaAction and saveCdaFieldInputsAction all UPDATE this
-- table, and uploadPreliminaryCdAction → notifyAgentOfPreliminaryCdAction
-- INSERTs it; the CDA workflow client puts a compliance officer on both paths
-- (`isCompliance = ["broker","admin","compliance_officer"]`). So that one
-- capability is MERGED FORWARD, tenant-scoped, below.
--
-- m433 reached the same conclusion from the read side and said so in its own
-- header — it put compliance_officer in can_read_brokerage_books() precisely
-- because "the existing compliance_officer_crud_cda policy on that table already
-- grants them the table outright" and removing it would break a working screen.
-- This migration removes that outright grant; the merge is what keeps m433's
-- finding true once the grant is gone.
--
-- DELETE is deliberately NOT merged forward: no reader in app/ or lib/ deletes a
-- row of this table, on any path, for any role. Deleting a settlement record is
-- not a compliance-review action, and the four `FOR ALL` policies granted it to
-- every broker on the platform purely as a side effect of USING governing DELETE
-- on a FOR ALL policy — the same trap m437 closed on four other money tables.
--
-- The merged policies are therefore PER-COMMAND (FOR INSERT, FOR UPDATE), never
-- FOR ALL. On a FOR ALL policy a read-shaped USING is a delete grant; per-command
-- policies cannot make that mistake by construction.
--
-- ── title_agent_select_cda IS DEAD CODE, and provably so ─────────────────────
--
-- Not "absent from today's census" — UNREACHABLE. m307 removed 'title_agent'
-- from users.user_type and the live CHECK constraint users_user_type_check now
-- admits only admin, agent, broker, broker_owner, compliance_officer, contact,
-- isa, lender, superadmin, support, system, tc, team_lead, vendor. No row can
-- ever hold 'title_agent', so the predicate is false for every user who will
-- ever exist. A title company is a VENDOR in this schema (vendors.category
-- includes 'title'); scripts/seat-display-simulator.ts asserts exactly this.
-- It is recorded as dead and dropped, not carefully preserved.
--
-- ── THE SAME CLASS ON THE OTHER THREE TABLES ─────────────────────────────────
--
-- Verified in pg_policy rather than assumed, and the census needed one
-- correction: vendor_subscriptions carries TWO of these, not one — a SELECT and
-- an unnamed-in-the-brief `FOR ALL`.
--
--   commission_structures  "Admins and brokers view commission structures" (SELECT)
--   commission_structures  "Admins can manage commission structures"       (ALL)
--   vendor_transactions    "Brokerages can view their transactions"        (SELECT)
--   vendor_subscriptions   "Brokerages can view their subscriptions"       (SELECT)
--   vendor_subscriptions   "Admins can manage all subscriptions"           (ALL)
--
-- All five are `EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND user_type
-- IN (...))` with no tenant term. All five are dropped and nothing is merged
-- forward, because NO application code depends on them:
--   * every commission_structures reader and writer (app/actions/settings/
--     list|create|delete-commission-structure.ts, lib/brokerage/
--     get-default-commission-structure.ts) uses createServiceClient(), which
--     bypasses RLS entirely and is role-gated in TypeScript;
--   * vendor_transactions and vendor_subscriptions have NO reader at all —
--     the only mention in app/ is a comment in vendor-contact-access.ts calling
--     them a future paid add-on.
-- The tenant-scoped *_tenant_* policies m433 left in place stay as they are.
--
-- ── SAFETY OF THE DROPS ──────────────────────────────────────────────────────
--
-- Nothing pins these policy names. `grep -rn` across scripts/ and
-- supabase/migrations/ finds them in exactly two places: m390, which rewrote
-- agent_crud_own_cda's agent clause and has already run, and two idempotent
-- bootstrap scripts (scripts/create-settings-tables.sql,
-- scripts/create-vendor-marketplace-system.sql) which would have RECREATED the
-- tenant-free policies on their next run — those blocks are removed in the same
-- commit. No guard asserts on them, so DROP/CREATE is on the table here in a way
-- it was not for m437.
--
-- The loop below refuses to drop a policy whose predicate has since ACQUIRED a
-- tenant test: if someone fixed one of these differently between the audit and
-- the apply, this migration stops rather than deleting their work.

do $$
declare
  targets text[][] := array[
    ['closing_disclosure_agreement', 'broker_crud_cda'],
    ['closing_disclosure_agreement', 'admin_crud_delete_cda'],
    ['closing_disclosure_agreement', 'compliance_officer_crud_cda'],
    ['closing_disclosure_agreement', 'agent_crud_own_cda'],
    ['closing_disclosure_agreement', 'title_agent_select_cda'],
    ['commission_structures',        'Admins and brokers view commission structures'],
    ['commission_structures',        'Admins can manage commission structures'],
    ['vendor_transactions',          'Brokerages can view their transactions'],
    ['vendor_subscriptions',         'Brokerages can view their subscriptions'],
    ['vendor_subscriptions',         'Admins can manage all subscriptions']
  ];
  i    int;
  pred text;
  n    int := 0;
begin
  for i in 1 .. array_length(targets, 1) loop
    select coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
      into pred
      from pg_policy p
      join pg_class     c on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public'
       and c.relname = targets[i][1]
       and p.polname = targets[i][2];

    if pred is null then
      raise notice 'm438: %.% is already gone — nothing to drop.', targets[i][1], targets[i][2];
      continue;
    end if;

    if pred ~ '(brokerage_id|has_brokerage_access|current_user_brokerage_id|user_brokerage_ids)' then
      raise exception
        'm438: %.% now carries a tenant test (%). It did not when this migration was written, so someone has repaired it another way — refusing to delete their work. Re-audit before dropping.',
        targets[i][1], targets[i][2], pred;
    end if;

    execute format('drop policy %I on public.%I', targets[i][2], targets[i][1]);
    n := n + 1;
  end loop;

  raise notice 'm438: dropped % tenant-free user_type policies.', n;
end $$;

-- ── THE MERGE: the one capability the tier policies did not carry ────────────
--
-- is_compliance_officer_role() already exists, is STABLE SECURITY DEFINER, and
-- states a POSITIVE list ('compliance_officer','compliance_manager'). Reused
-- rather than reinvented — the point of a named helper is that the next table
-- inherits the definition instead of copying a predicate, and a second helper
-- meaning the same thing is how two answers to one question get created.
--
-- has_brokerage_access(brokerage_id) is what the four dropped policies never
-- had. It is FALSE for a NULL brokerage_id, so an unstamped CDA is nobody's
-- (m434 claim 4), and it ORs in is_platform_admin() — never
-- can_read_tenant_financials(), which is a READ roster and must not appear in a
-- write clause (m434 claim 5).
--
-- FOR UPDATE carries the tenant test on BOTH USING and WITH CHECK: USING says
-- which rows compliance may act on, WITH CHECK says what the row may BECOME. An
-- unscoped WITH CHECK would let a compliance officer MOVE a settlement record
-- into another brokerage, which is the cross-tenant hole again wearing a
-- different hat.

create policy closing_disclosure_agreement_compliance_insert
  on public.closing_disclosure_agreement as permissive for insert to authenticated
  with check (public.has_brokerage_access(brokerage_id)
              and public.is_compliance_officer_role());

create policy closing_disclosure_agreement_compliance_update
  on public.closing_disclosure_agreement as permissive for update to authenticated
  using       (public.has_brokerage_access(brokerage_id)
               and public.is_compliance_officer_role())
  with check  (public.has_brokerage_access(brokerage_id)
               and public.is_compliance_officer_role());

do $$
declare n int;
begin
  select count(*) into n
  from   pg_policy p
  join   pg_class c on c.oid = p.polrelid
  join   pg_namespace ns on ns.oid = c.relnamespace
  where  ns.nspname = 'public'
    and  c.relname = 'closing_disclosure_agreement'
    and  p.polname in ('closing_disclosure_agreement_compliance_insert',
                       'closing_disclosure_agreement_compliance_update');
  if n <> 2 then
    raise exception 'm438: expected the 2 merged compliance policies, found %.', n;
  end if;

  select count(*) into n
  from   pg_policy p
  join   pg_class c on c.oid = p.polrelid
  join   pg_namespace ns on ns.oid = c.relnamespace
  where  ns.nspname = 'public'
    and  c.relname = 'closing_disclosure_agreement'
    and  p.polcmd = '*';
  if n <> 0 then
    raise exception
      'm438: closing_disclosure_agreement still carries % FOR ALL policy/policies. On a FOR ALL policy USING alone governs DELETE, which is how a read-shaped predicate became a delete grant on the platform''s settlement records. This table is per-command now.', n;
  end if;

  raise notice 'm438: the settlement record is tenant-scoped; compliance keeps its pen inside its own brokerage and nobody outside it holds one.';
end $$;
