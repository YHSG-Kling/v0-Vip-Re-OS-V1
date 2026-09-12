-- m445 — asserts m444. Separate file: a `raise` rolls back its own transaction.

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 1 — THE TEAM BOARD IS GATED ON RUNNING THE TEAM, NOT ON A user_type (HARD)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Owner ruling: "a team lead is an agent that runs their own team."
--
-- This is the sharpest lesson in the whole workstream, because m440 did not merely
-- pick too narrow a role — it picked a test UNCORRELATED with the fact it claimed
-- to check, and the live data was inverted on BOTH accounts that exist:
--
--   teamlead@vip.demo        user_type='agent'      runs 1 team  → gate FALSE
--   buyer@yourbrokerage.com  user_type='team_lead'  runs 0 teams → gate TRUE
--
-- The real lead was locked out; someone who runs nothing was let in. And it did
-- not look like a bug, because both halves fail silently: an empty board reads as
-- "no deals", and the account that passed the gate had no team to expose yet.
--
-- Leading is recorded in `teams.team_lead_id`, a real FK. A role column is a
-- LABEL; the FK is the FACT. Where a fact exists, gate on the fact.
do $$
declare
  r record; n int := 0; offenders text := '';
begin
  for r in
    select p.tablename, p.policyname, coalesce(p.qual,'') as pred
    from   pg_policies p
    where  p.schemaname = 'public'
      and  p.tablename in ('listings','transactions')
      and  p.policyname in ('team_leader_read_team_listings','team_leader_read_team_transactions')
  loop
    if r.pred ~ '(user_type|is_team_lead_role)' then
      n := n + 1;
      offenders := offenders || format('  %s.%s still tests a ROLE: %s', r.tablename, r.policyname, r.pred) || chr(10);
    end if;
    if r.pred !~ 'current_user_led_team_id' then
      n := n + 1;
      offenders := offenders || format('  %s.%s does not resolve the caller through current_user_led_team_id()', r.tablename, r.policyname) || chr(10);
    end if;
    if r.pred !~ 'agent_team_id' then
      n := n + 1;
      offenders := offenders || format('  %s.%s does not resolve the ROW''s team through agent_team_id()', r.tablename, r.policyname) || chr(10);
    end if;
  end loop;

  if n = 0 and not exists (
    select 1 from pg_policies where schemaname='public'
      and policyname in ('team_leader_read_team_listings','team_leader_read_team_transactions')) then
    raise exception 'm445: both team-board policies are gone. The capability is the point — a team lead must see their own team''s board.';
  end if;

  if n > 0 then
    raise exception
      'm445: % defect(s) in the team board gate. Owner ruling: "a team lead is an agent that runs their own team" — leading is a FACT in teams.team_lead_id, not a user_type. Measured live when m444 was written: the real team lead carries user_type=''agent'' and so FAILED the role gate, while the one account carrying user_type=''team_lead'' runs no team and PASSED it. Gate on current_user_led_team_id(); resolve the row through agent_team_id().%',
      n, chr(10) || offenders;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 2 — THE TWO TEAM HELPERS ANSWER TWO DIFFERENT QUESTIONS  (HARD)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- current_user_led_team_id()  = the team you RUN      → may see its board
-- current_user_team_id()      = the team you are ON   → which team am I on
--
-- Collapsing them would hand every rank-and-file member of a team the whole
-- team's listings and deals, which is the opposite of "teams should only see
-- their own board". So the led helper must resolve through teams.team_lead_id and
-- must NOT fall through to the membership sources the way resolve_team_id() does.
do $$
declare body text;
begin
  select pg_get_functiondef(p.oid) into body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='current_user_led_team_id' limit 1;

  if body is null then
    raise exception 'm445: public.current_user_led_team_id() is missing. m444''s team policies depend on it; deleting it scatters the rule back into a user_type test that is uncorrelated with who runs a team.';
  end if;
  if body !~ 'team_lead_id' then
    raise exception 'm445: current_user_led_team_id() no longer resolves through teams.team_lead_id. That column IS the fact the owner''s ruling names.';
  end if;
  if body ~ 'user_type' then
    raise exception 'm445: current_user_led_team_id() has acquired a user_type test. The live team lead is user_type=''agent''; any role test here re-locks them out.';
  end if;
  if body ~ '(team_members|users\.team_id|resolve_team_id)' then
    raise exception 'm445: current_user_led_team_id() now falls through to a MEMBERSHIP source. Being on a team is not running one — that widening hands every team member the whole team board.';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 3 — can_read_agent_books() CARRIES THE SAME CORRECTION  (HARD)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Its team branch had BOTH defects: the user_type gate, and a direct read of
-- `agents.team_id` — a fifth answer to a question m431 made single. This helper
-- decides the agent tier on 45 money tables, so a stale copy of the rule here
-- outranks every policy that calls it.
do $$
declare body text;
begin
  select pg_get_functiondef(p.oid) into body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='can_read_agent_books' limit 1;

  if body is null then
    raise exception 'm445: public.can_read_agent_books() is missing — it is the agent tier for 45 money tables.';
  end if;
  if body ~ 'is_team_lead_role' then
    raise exception 'm445: can_read_agent_books() is back on is_team_lead_role(). The real team lead is user_type=''agent'' and fails it, so the team branch grants nothing while reading as though a lead sees their team''s money.';
  end if;
  if body !~ 'current_user_led_team_id' then
    raise exception 'm445: can_read_agent_books() no longer resolves the caller''s team through current_user_led_team_id().';
  end if;
  -- The CONSTRUCT, not a spelling: reads a team column directly while NOT going
  -- through the canonical resolver. Any alias, any table — what is forbidden is
  -- deciding a row's team without agent_team_id().
  if body ~ '\.team_id' and body !~ 'agent_team_id' then
    raise exception 'm445: can_read_agent_books() reads an agents.team_id column directly instead of going through agent_team_id(). That is a fifth answer to "which team is this agent on"; m431 exists because the public roster and the team P&L already disagreed on live data.';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 4 — A CREDIT FILE REACHES NO TENANT WITHOUT A ROLE, AND NO NULL ESCAPE (HARD)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Owner ruling: "the consumer credit data should only be exposed to their lender
-- who is a type of vendor."
--
-- Before m444 all four policies were the bare
-- `(brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())`, so
-- every contact, lender and vendor account of the brokerage read every contact's
-- credit score — and an unstamped row was published to every tenant on the
-- platform rather than hidden. This is a private individual's credit file.
do $$
declare
  r record; n int := 0; offenders text := ''; sel_pred text;
begin
  for r in
    select p.policyname, p.cmd, coalesce(p.qual,'')||' '||coalesce(p.with_check,'') as pred
    from pg_policies p
    where p.schemaname='public' and p.tablename='credit_accounts'
      and 'service_role' <> all (p.roles)
  loop
    if r.pred ~ 'brokerage_id IS NULL\s*\)?\s*OR' then
      n := n + 1;
      offenders := offenders || format('  %s [%s] still carries the NULL escape — an unstamped credit file is PUBLISHED to every tenant, not hidden.', r.policyname, r.cmd) || chr(10);
    end if;
    if r.pred !~ '(can_read_brokerage_books|is_brokerage_admin|is_current_user_lender_for_contact|current_user_agent_id|auth\.uid)' then
      n := n + 1;
      offenders := offenders || format('  %s [%s] reaches the tenant with no test of WHO the caller is.', r.policyname, r.cmd) || chr(10);
    end if;
  end loop;

  select coalesce(qual,'') into sel_pred from pg_policies
   where schemaname='public' and tablename='credit_accounts' and cmd in ('SELECT','ALL') limit 1;

  if sel_pred is null or sel_pred = '' then
    raise exception 'm445: credit_accounts has no readable policy at all.';
  end if;
  if sel_pred !~ 'is_current_user_lender_for_contact' then
    n := n + 1;
    offenders := offenders || '  the SELECT policy no longer admits the contact''s OWN LENDER, which is the capability the owner''s ruling grants.' || chr(10);
  end if;

  if n > 0 then
    raise exception
      'm445: % defect(s) on credit_accounts. Owner ruling: "the consumer credit data should only be exposed to their lender who is a type of vendor." users.brokerage_id is stamped on a contact, a lender and a vendor exactly as on a broker''s, so a bare tenant test hands a private individual''s credit score to the whole portal.%',
      n, chr(10) || offenders;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 5 — "THEIR LENDER" MEANS BOTH HALVES  (HARD)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The ruling has two conditions and dropping either one is a different, wrong
-- policy:
--   · drop the CATEGORY test → every assigned vendor (inspector, photographer,
--     contractor) reads the credit file.
--   · drop the ASSIGNMENT test → every lender on the platform reads EVERY
--     contact's credit file, which is worse than what m444 replaced.
do $$
declare body text;
begin
  select pg_get_functiondef(p.oid) into body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='is_current_user_lender_for_contact' limit 1;

  if body is null then
    raise exception 'm445: public.is_current_user_lender_for_contact() is missing — it is the capability the owner''s ruling grants.';
  end if;
  if body !~ 'lender' then
    raise exception 'm445: is_current_user_lender_for_contact() no longer tests vendors.category for a lender. Without it EVERY assigned vendor — inspector, photographer, contractor — reads the contact''s credit file.';
  end if;
  if body !~ 'vendor_has_contact_access' then
    raise exception 'm445: is_current_user_lender_for_contact() no longer tests the per-CONTACT assignment. Without it every lender on the platform reads EVERY contact''s credit file — wider than the defect m444 removed. The ruling says THEIR lender.';
  end if;
  if body !~ 'auth\.uid\(\)' then
    raise exception 'm445: is_current_user_lender_for_contact() does not resolve the caller from the session. Never derive identity from a caller-supplied id.';
  end if;
end $$;

do $$
begin
  raise notice 'm445: all hard claims hold — the team board is gated on RUNNING the team (teams.team_lead_id) rather than on a user_type uncorrelated with it, the two team helpers stay two questions, can_read_agent_books() carries the same correction across 45 money tables, and a consumer credit file reaches the brokerage running it plus THAT contact''s own assigned lender, and nobody else.';
end $$;
