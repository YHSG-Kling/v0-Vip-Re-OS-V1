-- m443 — asserts m442.
--
-- Separate file because a `raise` rolls back its own transaction: asserting
-- inside m442 would undo the drops and the twelve policies it is checking.
--
-- ── WHY THE HARD CLAIMS ARE SCOPED TO A FAMILY AND NOT SCHEMA-WIDE ───────────
--
-- Measured before writing, which is the whole reason the scope is what it is:
--
--   · the NULL-escape construct — `<tenant col> IS NULL OR <tenant col> = …` —
--     appears on **464 policies across ~180 tables** right now. That is the
--     unburned tail of #156, not a regression m442 could introduce. A schema-wide
--     hard claim would go red on the day it applied, on somebody else's table,
--     which is how a guard gets commented out. It is a HARD failure on the
--     settlement family, where it has just been closed, and a COUNTED WARNING
--     everywhere else so a green run can never be read as "the class is gone".
--
--   · the tenant-free `user_type` construct is nearly closed: **6 policies**
--     schema-wide, on contacts, cron_health_snapshot, tenant_safety_findings,
--     transactions and vendor_bookings. Small enough to name, and some are
--     legitimately platform-scoped tables with no tenant to anchor to — which is
--     a judgement per table, not a sweep. Named as a warning, hard on the family.
--
-- This is the same shape m441 settled on and for the same reason: assert hard
-- exactly where the work was done and where the claim is TRUE, and publish the
-- remaining count so the number cannot quietly become folklore.

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 1 — EVERY POLICY ON THE SETTLEMENT FAMILY CARRIES A TENANT ANCHOR (HARD)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A role test says WHO may act; it never says WHICH ROWS. Before m442, a broker
-- at one brokerage could read, alter and DELETE another brokerage's settlement
-- figures because six policies' entire predicate was one `user_type` comparison.
--
-- "Carries a tenant anchor" is deliberately satisfied by ANY of: the house
-- helper, a raw brokerage comparison, a tier helper that contains one, or an
-- EXISTS through `closing_disclosure_agreement` (which is how a child table with
-- no tenant column of its own reaches one). The construct is "this predicate
-- narrows to a tenant SOMEHOW", not a spelling — this must pass on strictly
-- better code that gets there another way.
do $$
declare
  r         record;
  n         int  := 0;
  offenders text := '';
begin
  for r in
    select p.tablename, p.policyname, p.cmd,
           coalesce(p.qual,'') || ' ' || coalesce(p.with_check,'') as pred
    from   pg_policies p
    where  p.schemaname = 'public'
      and  p.tablename in ('closing_disclosure','cda_comparison_results','closing_disclosure_agreement')
      and  'service_role' <> all (p.roles)
    order  by p.tablename, p.policyname
  loop
    if r.pred !~ '(has_brokerage_access|current_user_brokerage_id|user_brokerage_ids|brokerage_id|closing_disclosure_agreement|can_read_tenant_financials|can_read_brokerage_books|can_read_agent_books|vendor_has_transaction_access|title_agent_id|current_user_agent_id)' then
      n := n + 1;
      offenders := offenders || format('  %s.%s [%s]  →  %s', r.tablename, r.policyname, r.cmd, r.pred) || chr(10);
    end if;
  end loop;

  if n > 0 then
    raise exception
      'm443: % polic(ies) on the settlement record reach rows with no tenant anchor of any kind. A role test says WHO may act, never WHICH ROWS — without a tenant term this grants that role EVERY brokerage''s closing figures, and on a FOR ALL policy that includes DELETE. Permissive policies OR together, so a correctly-scoped policy sitting beside one of these protects nothing at all.%',
      n, chr(10) || offenders;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 2 — NO NULL ESCAPE ON THE SETTLEMENT FAMILY  (HARD)
--            + THE SCHEMA-WIDE COUNT, NAMED  (WARNING)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- THE SEVERITY OF THIS ONE IS THE OPPOSITE OF HOW IT READS, and that is exactly
-- why it survived so long:
--
--     (brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())
--
-- looks like "untenanted rows are hidden". It means an unstamped row satisfies
-- the FIRST disjunct for EVERY caller of EVERY tenant — the row is PUBLISHED
-- PLATFORM-WIDE, not hidden. On a FOR ALL policy carrying the same expression as
-- its WITH CHECK, it is published on SELECT, INSERT, UPDATE and DELETE, and
-- anybody may create such a row, i.e. create a row everybody can read.
--
-- `has_brokerage_access(NULL)` is FALSE by construction. That is why every policy
-- written since m427 anchors on the helper rather than on a raw comparison.
do $$
declare
  r         record;
  n_fam     int  := 0;
  n_wide    int  := 0;
  n_tables  int  := 0;
  offenders text := '';
begin
  for r in
    select p.tablename, p.policyname, p.cmd
    from   pg_policies p
    where  p.schemaname = 'public'
      and  p.tablename in ('closing_disclosure','cda_comparison_results','closing_disclosure_agreement')
      and  (coalesce(p.qual,'') || ' ' || coalesce(p.with_check,''))
           ~ '(brokerage_id|tenant_id|organization_id) IS NULL\s*\)?\s*OR'
    order  by p.tablename, p.policyname
  loop
    n_fam := n_fam + 1;
    offenders := offenders || format('  %s.%s [%s]', r.tablename, r.policyname, r.cmd) || chr(10);
  end loop;

  if n_fam > 0 then
    raise exception
      'm443: % polic(ies) on the settlement record let an UNSTAMPED row through. `brokerage_id IS NULL OR brokerage_id = …` does not hide an untenanted row — it PUBLISHES it to every tenant, because NULL satisfies the first disjunct for everybody. Anchor on has_brokerage_access(), which is FALSE for NULL by construction.%',
      n_fam, chr(10) || offenders;
  end if;

  select count(*), count(distinct tablename) into n_wide, n_tables
  from   pg_policies
  where  schemaname = 'public'
    and  (coalesce(qual,'') || ' ' || coalesce(with_check,''))
         ~ '(brokerage_id|tenant_id|organization_id) IS NULL\s*\)?\s*OR';

  if n_wide > 0 then
    raise warning
      'm443: the settlement family is clean, but % polic(ies) across % table(s) elsewhere in public still carry the NULL-escape disjunct. That is the unburned tail of #156, not a regression — and it is reported with its number precisely so a green run on this migration is never read as "the class is gone". Each one publishes any unstamped row of its table to every tenant on the platform.',
      n_wide, n_tables;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 3 — NO `FOR ALL` POLICY ON THE TWO REPAIRED TABLES  (HARD)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- m437's lesson, made structural instead of patched. On a `FOR ALL` policy, USING
-- alone governs DELETE — there is no WITH CHECK to stop it — so a READ-shaped
-- expression sitting in a FOR ALL USING **is a delete grant**. m433 shipped
-- exactly that on four money tables and m437 had to bolt RESTRICTIVE DELETE
-- policies on afterwards to subtract it back.
--
-- Per-command policies cost one extra CREATE and remove the failure mode
-- entirely, so on these two tables the shape itself is now the invariant.
do $$
declare
  r         record;
  n         int  := 0;
  offenders text := '';
begin
  for r in
    select p.tablename, p.policyname
    from   pg_policies p
    where  p.schemaname = 'public'
      and  p.tablename in ('closing_disclosure','cda_comparison_results')
      and  p.cmd = 'ALL'
      and  'service_role' <> all (p.roles)
    order  by p.tablename, p.policyname
  loop
    n := n + 1;
    offenders := offenders || format('  %s.%s', r.tablename, r.policyname) || chr(10);
  end loop;

  if n > 0 then
    raise exception
      'm443: % FOR ALL polic(ies) are back on the settlement record. On a FOR ALL policy USING alone decides DELETE, so the read expression becomes a delete grant on the brokerage''s closing figures — m433 shipped that defect and m437 had to subtract it back with restrictive policies. Write four per-command policies instead: the read gets the tier, the write gets the write roster.%',
      n, chr(10) || offenders;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 4 — NOTHING IN THE FAMILY IS GRANTED TO PUBLIC  (HARD)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A policy granted TO PUBLIC is evaluated for `anon` as well. Every predicate
-- here bottoms out in a helper that reads `users WHERE id = auth.uid()`, and
-- auth.uid() is NULL for an anonymous caller — so this was harmless today only
-- because of the INTERNALS OF FIVE FUNCTIONS rather than because of the grant.
-- Depending on that is a choice, and it is the wrong one on the settlement
-- record. m431 §C narrowed commission_splits for exactly this reason.
do $$
declare
  r         record;
  n         int  := 0;
  offenders text := '';
begin
  for r in
    select p.tablename, p.policyname, p.cmd
    from   pg_policies p
    where  p.schemaname = 'public'
      and  p.tablename in ('closing_disclosure','cda_comparison_results','closing_disclosure_agreement')
      and  p.roles = '{public}'
    order  by p.tablename, p.policyname
  loop
    n := n + 1;
    offenders := offenders || format('  %s.%s [%s]', r.tablename, r.policyname, r.cmd) || chr(10);
  end loop;

  if n > 0 then
    raise exception
      'm443: % polic(ies) on the settlement record are granted TO PUBLIC, so they are evaluated for `anon`. Grant TO authenticated: the table''s safety must not rest on auth.uid() happening to be NULL inside a helper.%',
      n, chr(10) || offenders;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 5 — THE CAPABILITIES SURVIVED THE REPAIR  (HARD)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- m416's lesson, and m441 claim 4 repeated it: assert that the REWRITE landed,
-- not only that the defect left. Claims 1–4 all pass just as happily if someone
-- deletes every policy on both tables — the class would be clean and the
-- capability gone. Three specific things m442 was careful to PRESERVE rather than
-- delete, each of which a later "simplification" would silently drop:
--
--   · THE TITLE COMPANY. m440 dropped two policies that gated on `title_agent`,
--     a user_type m307 removed — so they granted nothing to anybody. m442 brought
--     the CAPABILITY back through `closing_disclosure.title_agent_id`, a real
--     column with a real FK to users(id), which is strictly better than what was
--     dropped: per-ROW rather than per-role, so it cannot leak one title
--     company's closing to another's. Losing a dead predicate is a fix; losing
--     the capability it was reaching for is a regression.
--
--   · THE CHILD'S ANCHOR. `cda_comparison_results` has NO brokerage_id. Its
--     tenant is reached through `cda_id` → closing_disclosure_agreement. If that
--     EXISTS is ever replaced by a copied brokerage_id column, the tenant lives
--     in two places and they will disagree.
--
--   · THE AGENT'S OWN ROW. `agent_select_own_cda_comparison` resolves through
--     closing_disclosure_agreement.agent_id = current_user_agent_id(). m390
--     installed that deliberately to stop an agents.id being compared against a
--     users.id — the id-class defect m441 claim 6 exists to catch.
do $$
declare
  pred text;
begin
  select coalesce(qual,'') into pred from pg_policies
   where schemaname='public' and tablename='closing_disclosure' and policyname='closing_disclosure_tenant_select';

  if pred is null or pred = '' then
    raise exception 'm443: closing_disclosure has no tenant SELECT policy. m442 created one; a table with a tenant-anchored read deleted is not "clean", it is a lost capability.';
  end if;
  if pred !~ 'title_agent_id' then
    raise exception
      'm443: closing_disclosure''s read no longer admits the title company through title_agent_id. m440 dropped two policies gating on the user_type ''title_agent'' (which m307 removed, so they granted nothing); m442 restored the CAPABILITY through the column that actually carries it. Removing that branch loses a real party to a real closing — and it is per-row, so it is strictly safer than the role test it replaced.';
  end if;
  if pred !~ 'vendor_has_transaction_access' then
    raise exception
      'm443: closing_disclosure''s read no longer honours vendor_has_transaction_access(). A title company IS a vendor here (vendors.category = ''title''); that helper already existed and is the route m440 named when it removed the dead one. Reuse it, do not invent a second answer.';
  end if;

  select coalesce(qual,'') into pred from pg_policies
   where schemaname='public' and tablename='cda_comparison_results' and policyname='cda_comparison_tenant_select';

  if pred is null or pred = '' then
    raise exception 'm443: cda_comparison_results has no tenant SELECT policy.';
  end if;
  if pred !~ 'closing_disclosure_agreement' then
    raise exception
      'm443: cda_comparison_results no longer reaches its tenant through closing_disclosure_agreement. This table has NO brokerage_id — cda_id is its only route to a tenant, and it is a real foreign key. Copying a brokerage_id onto the row instead would put the tenant in two places, and two places disagree.';
  end if;

  select coalesce(qual,'') into pred from pg_policies
   where schemaname='public' and tablename='cda_comparison_results' and policyname='agent_select_own_cda_comparison';

  if pred is null then
    raise exception
      'm443: cda_comparison_results.agent_select_own_cda_comparison is gone. m442 KEPT it deliberately — it is the agent''s own-row read, and m390 installed its agent_id resolution to stop an agents.id being compared against a users.id.';
  end if;
  if pred !~ 'current_user_agent_id' then
    raise exception
      'm443: agent_select_own_cda_comparison no longer resolves the agent through current_user_agent_id(). closing_disclosure_agreement.agent_id holds an agents.id, not a users.id; comparing it to auth.uid() is false for every row that will ever exist (m390, and the same id-class defect m441 claim 6 catches for vendors).';
  end if;
end $$;

do $$
begin
  raise notice 'm443: all hard claims hold — every policy on the settlement record carries a tenant anchor, no unstamped row is published to every tenant, no FOR ALL policy can turn a read expression into a delete grant, nothing is evaluated for anon, and the title company, the child table''s anchor through its parent, and the agent''s own-row read all survived the repair. The schema-wide NULL-escape count is reported above as a warning; it is the unburned tail of #156.';
end $$;
