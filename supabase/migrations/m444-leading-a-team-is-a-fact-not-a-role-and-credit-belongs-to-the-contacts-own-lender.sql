-- m444 — TWO OWNER RULINGS. The first one CORRECTS m440.
--
--   "a team lead is an agent that runs their own team"
--   "the consumer credit data should only be exposed to their lender who is a
--    type of vendor"
--
-- ═════════════════════════════════════════════════════════════════════════════
-- A. LEADING A TEAM IS A FACT, NOT A user_type — AND m440 GOT THIS BACKWARDS
-- ═════════════════════════════════════════════════════════════════════════════
--
-- m440 gated the team board on `is_team_lead_role()`, i.e. `user_type IN
-- ('team_lead','team_leader')`. W37 then recorded that the ruling was "inert on
-- live data until users.user_type is corrected". That note was wrong, and the
-- owner's ruling says why: a team lead is an AGENT WHO RUNS A TEAM. There is
-- nothing to correct in the data. The POLICY was wrong.
--
-- Measured live, and it is inverted on BOTH accounts that exist:
--
--   teamlead@vip.demo        user_type = 'agent'      leads 1 team
--                            → is_team_lead_role() = FALSE
--                            → the REAL team lead was granted NOTHING.
--
--   buyer@yourbrokerage.com  user_type = 'team_lead'  leads 0 teams
--                            → is_team_lead_role() = TRUE
--                            → someone who runs no team PASSED the gate, and
--                              would have read a team board the moment any team
--                              named them.
--
-- So the role test is not merely too narrow; it is uncorrelated with the fact it
-- claims to test. `teams.team_lead_id` is the fact — a real FK to users(id) — and
-- m431's resolve_team_id() ALREADY ranks it first for exactly this reason.
--
-- ── WHY NOT JUST USE current_user_team_id() ──────────────────────────────────
--
-- Because it answers a DIFFERENT question. resolve_team_id() returns the team you
-- are ON — you lead it, OR your user record names it, OR an active team_members
-- row does, OR your agent row does. Gating the team BOARD on that would hand every
-- rank-and-file member of a team the whole team's listings and deals. The ruling
-- is about who RUNS the team, so the helper below resolves ONLY the lead link and
-- nothing else. Two questions, two functions — which is why this is not folded
-- into current_user_team_id().
--
-- NULL still means fail-closed: run no team, see no team board.

create or replace function public.current_user_led_team_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.id
  from   public.teams t
  where  t.team_lead_id = auth.uid()
    and  t.deleted_at is null
  limit  1;
$$;

comment on function public.current_user_led_team_id() is
  'The team the CALLER RUNS, resolved from the fact that records it: teams.team_lead_id. Owner ruling: "a team lead is an agent that runs their own team" — leading is a fact, not a user_type, and the live data proves it: the real team lead carries user_type=''agent'' while the one account with user_type=''team_lead'' leads no team. NOT a synonym for current_user_team_id(), which returns the team you are ON (lead OR member OR agent row) and would therefore hand every team member the whole team board. Use this one for "may I see this team''s board"; use current_user_team_id() for "which team am I on". NULL = runs no team = fail closed.';

revoke all on function public.current_user_led_team_id() from public;
grant execute on function public.current_user_led_team_id() to authenticated, service_role;

-- The two team-board policies lose their user_type gate entirely. Leading the
-- team IS the authorisation; a second test on a role nobody reliably holds can
-- only subtract the real lead, which is precisely what it did.
do $$
begin
  alter policy team_leader_read_team_listings on public.listings
    using (
      public.current_user_led_team_id() is not null
      and public.has_brokerage_access(brokerage_id)
      and public.agent_team_id(agent_id) = public.current_user_led_team_id()
    );

  alter policy team_leader_read_team_transactions on public.transactions
    using (
      public.current_user_led_team_id() is not null
      and public.has_brokerage_access(brokerage_id)
      and (   public.agent_team_id(agent_id)        = public.current_user_led_team_id()
           or public.agent_team_id(seller_agent_id) = public.current_user_led_team_id()
           or public.agent_team_id(buyer_agent_id)  = public.current_user_led_team_id())
    );

  raise notice 'm444: the team board is now gated on RUNNING the team (teams.team_lead_id), not on a user_type. The live team lead — an agent — can finally see it, and the team_lead account that runs no team cannot.';
end $$;

-- can_read_agent_books() carried the SAME defect in its team branch, and a second
-- one beside it: it read `agents.team_id` directly rather than going through
-- agent_team_id(), making it a FIFTH answer to "which team is this agent on"
-- (m431 exists to make there be exactly one). Both fixed in place; every other
-- branch is byte-for-byte what m433 shipped.
create or replace function public.can_read_agent_books(target_agent_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.can_read_tenant_financials()
      or public.can_read_brokerage_books()
      or (target_agent_id is not null and target_agent_id = public.current_user_agent_id())
      or (target_agent_id is not null
          and public.current_user_led_team_id() is not null
          and public.agent_team_id(target_agent_id) = public.current_user_led_team_id());
$$;

comment on function public.can_read_agent_books(uuid) is
  'May the caller read this agent''s books? Platform financial tier, or the brokerage''s books tier, or the agent themself, or THE LEAD OF THE TEAM THAT AGENT IS ON. The team branch resolves the caller through current_user_led_team_id() (the team they RUN) and the row through agent_team_id() — never through a user_type and never by reading agents.team_id directly, which was a fifth answer to a question m431 made single. Owner ruling: "a team lead is an agent that runs their own team".';

-- ═════════════════════════════════════════════════════════════════════════════
-- B. CONSUMER CREDIT DATA BELONGS TO THE CONTACT'S OWN LENDER
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHAT IS THERE, measured: all four `credit_accounts` policies are the bare
-- `(brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())` — the
-- NULL escape, on SELECT, INSERT, UPDATE and DELETE. So today every authenticated
-- user of the brokerage — the four contacts, the two lenders, the two vendors
-- included — reads every contact's `current_credit_score`, `target_credit_score`,
-- `credit_amount`, stage history and notes. And an unstamped row is published to
-- every tenant on the platform, not hidden.
--
-- This is consumer credit information about a private individual. It is the
-- sharpest read on the table and it was the widest.
--
-- ── THE LINKAGE EXISTS ALREADY; NOTHING IS INVENTED ─────────────────────────
--
-- The owner's ruling maps exactly onto the schema as built:
--   · "a type of vendor" — `vendors.category` CHECK admits 'lender' and
--     'refinance_lender'. A lender IS a vendor category here.
--   · "THEIR lender"     — `vendor_contact_assignments` is the per-CONTACT grant
--     (status, expires_at, revoked_at), and `public.vendor_has_contact_access
--     (p_contact_id)` already resolves it. Reused, not rewritten.
--
-- So "their lender" is not a new concept needing a new column. It is: a vendor of
-- lender category, holding a live assignment to THAT contact.
--
-- ── HOW THE RULING WAS READ, STATED PLAINLY SO IT CAN BE CORRECTED ──────────
--
-- Read strictly, "only ... their lender" would also exclude the brokerage's own
-- agents and brokers. That is NOT how it is implemented, and here is the evidence
-- it should not be: `app/actions/credit-copilot.ts` is a live, session-client
-- surface behind `app/credit-pipeline`, and it states its own tier in a comment
-- above the query —
--
--     "An agent sees only their own book; broker/admin roles see the brokerage."
--
-- Since it uses a SESSION client, RLS is the real gate; cutting the brokerage out
-- would blank the credit pipeline for the very people who run it. The house rule
-- is that a policy which breaks a broker's own dashboard is a defect in the
-- policy, not in the screen.
--
-- So the ruling is implemented as narrowing the OUTSIDE parties: among everyone
-- who is not the brokerage running the file, ONLY the contact's own lender may
-- see it. Contacts, other vendors, other lenders and unrelated portal accounts
-- all lose the access they have today. IF the intent was stricter — the lender and
-- the named agent only, with no brokerage-wide read — say so and it is a one-line
-- change to this policy.
--
-- Deliberately NOT given a platform branch. can_read_tenant_financials() is for a
-- TENANT'S financials; a private individual's credit file is not the brokerage's
-- money, and no ruling has put platform staff inside it. Fail closed, and report.

create or replace function public.is_current_user_lender_for_contact(p_contact_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_contact_id is not null
     and exists (
       select 1
       from   public.user_role_assignments ura
       join   public.vendors v on v.id = ura.vendor_id
       where  ura.user_id = auth.uid()
         and  v.category in ('lender', 'refinance_lender')
     )
     and public.vendor_has_contact_access(p_contact_id);
$$;

comment on function public.is_current_user_lender_for_contact(uuid) is
  'Is the caller THIS CONTACT''S OWN LENDER? Owner ruling: "the consumer credit data should only be exposed to their lender who is a type of vendor." Two conditions, both required: the caller is a vendor whose vendors.category is ''lender'' or ''refinance_lender'' (the categories the live CHECK admits), AND vendor_has_contact_access() says they hold a live, unrevoked, unexpired assignment to THAT contact. Being a lender is not enough — it must be their contact. Reuses the existing assignment helper rather than adding a second answer to "which clients is this vendor on". An unlinked lender resolves FALSE and sees nothing, which is the correct failure direction for a consumer credit file.';

revoke all on function public.is_current_user_lender_for_contact(uuid) from public;
grant execute on function public.is_current_user_lender_for_contact(uuid) to authenticated, service_role;

-- TWO COLUMNS CALLED agent_id, TWO DIFFERENT ID CLASSES, IN ONE PREDICATE.
-- Verified in pg_constraint before writing, because this is the exact trap m390
-- and m441 claim 6 exist to catch:
--
--   credit_accounts.agent_id  →  FK users(id)   so it is compared to auth.uid()
--   contacts.agent_id         →  an agents.id   so it is compared to
--                                current_user_agent_id()
--
-- Swap the two comparisons and both branches are false for every row that will
-- ever exist, and the table would silently grant nothing while reading as though
-- the agent who owns the file can see it.
do $$
declare
  read_expr constant text :=
    '(    public.has_brokerage_access(brokerage_id)
      and (   public.can_read_brokerage_books()
           or (agent_id is not null and agent_id = auth.uid())
           or exists (select 1 from public.contacts c
                       where c.id = credit_accounts.contact_id
                         and c.agent_id = public.current_user_agent_id())))
     or public.is_current_user_lender_for_contact(contact_id)';

  write_expr constant text :=
    'public.has_brokerage_access(brokerage_id)
     and (   public.is_brokerage_admin()
          or (agent_id is not null and agent_id = auth.uid())
          or exists (select 1 from public.contacts c
                      where c.id = credit_accounts.contact_id
                        and c.agent_id = public.current_user_agent_id()))';
  pol record;
  n_sel int := 0;
  n_wri int := 0;
begin
  for pol in
    select p.policyname, p.cmd from pg_policies p
    where p.schemaname='public' and p.tablename='credit_accounts'
      and 'service_role' <> all (p.roles)
  loop
    if pol.cmd = 'SELECT' then
      execute format('alter policy %I on public.credit_accounts using (%s)', pol.policyname, read_expr);
      n_sel := n_sel + 1;
    elsif pol.cmd = 'INSERT' then
      execute format('alter policy %I on public.credit_accounts with check (%s)', pol.policyname, write_expr);
      n_wri := n_wri + 1;
    elsif pol.cmd = 'UPDATE' then
      execute format('alter policy %I on public.credit_accounts using (%s) with check (%s)', pol.policyname, write_expr, write_expr);
      n_wri := n_wri + 1;
    elsif pol.cmd = 'DELETE' then
      execute format('alter policy %I on public.credit_accounts using (%s)', pol.policyname, write_expr);
      n_wri := n_wri + 1;
    elsif pol.cmd = 'ALL' then
      execute format('alter policy %I on public.credit_accounts using (%s) with check (%s)', pol.policyname, read_expr, write_expr);
      n_sel := n_sel + 1; n_wri := n_wri + 1;
    end if;
    execute format('alter policy %I on public.credit_accounts to authenticated', pol.policyname);
  end loop;

  if n_sel = 0 then
    raise exception 'm444: credit_accounts has no readable policy to rewrite. Re-audit before assuming the table is closed.';
  end if;

  -- The LENDER branch is deliberately OUTSIDE the tenant AND: a lender is an
  -- outside party who may not carry the brokerage's brokerage_id at all, and the
  -- assignment — not the tenant stamp — is what authorises them. It is still
  -- per-CONTACT, so it can never widen past the one file they were assigned.
  raise notice 'm444: credit_accounts — % read and % write clause(s) rewritten. The NULL escape is gone (an unstamped credit file is no longer published to every tenant), contacts/vendors/unrelated lenders lose the access they had, and the contact''s OWN lender gains exactly their own contact''s file.', n_sel, n_wri;
end $$;
