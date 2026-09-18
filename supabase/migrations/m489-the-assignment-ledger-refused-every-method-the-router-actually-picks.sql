-- m489-the-assignment-ledger-refused-every-method-the-router-actually-picks.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- ONE CONCEPT — "how was this lead routed" — WAS SPELLED IN THREE DIFFERENT
-- VOCABULARIES ACROSS THREE COLUMNS, AND THE LEDGER CARRIED THE NARROWEST ONE,
-- SO THE LEDGER RECORDED NOTHING.
--
-- The three columns, all CHECK-constrained, all VALIDATED, all read out of the
-- live database before this file was written:
--
--   assignment_rules.rule_type
--     round_robin | load_balance | geo_based | specialization | manual
--   brokerages.default_assignment_method                       (m305)
--     round_robin | load_balance | geo_based | specialization | manual
--   assignment_log.assignment_method              ← THE LEDGER, THE ODD ONE OUT
--     rule_match | round_robin | load_balance | manual | ai_recommendation
--
-- The first two are the SAME five methods. The third is a different five: it
-- lacks `geo_based` and `specialization` — two of the five methods a broker can
-- actually choose in Settings — and adds two log-only values of its own.
--
-- WHY THAT IS NOT COSMETIC. lib/kernel/lead-acquisition-handlers.ts:413 inserts
-- the router's chosen method into `assignment_log.assignment_method` VERBATIM,
-- and the router's vocabulary is the rule/default vocabulary plus documented
-- decorations that lib/lead-assignment/ adds to say WHERE the decision came from:
--
--   solo_agent                     assignment-engine.ts:201 (solo tenant shortcut)
--   default_<method>               default-assignment.ts:97 (brokerage-wide policy)
--   team_<method>                  assignment-engine.ts:138 (team-scoped rule)
--   <method>_no_match              rule-matcher.ts:229/241  (narrow found nobody)
--   <method>_coverage              assignment-engine.ts:251 (coverage-mode redirect)
--
-- Not one of those is in the ledger's CHECK. MEASURED, by probing the live
-- constraint before writing this file:
--
--   solo_agent            → CHECK_REFUSED
--   default_load_balance  → CHECK_REFUSED
--   specialization        → CHECK_REFUSED
--
-- And the insert that meets that refusal is not destructured — `await
-- supabase.from('assignment_log').insert({...})` with no `{ error }` — and
-- supabase-js RESOLVES a refused write. So every assignment except a bare
-- `round_robin` / `load_balance` / `manual` set `leads.agent_id`, advanced the
-- lifecycle, created the contact, notified the agent … and wrote NO LEDGER ROW,
-- silently, with no error anywhere. `assignment_log` holds 0 rows on this
-- database, which is the observable end of that sentence.
--
-- WHAT DEPENDS ON THE LEDGER, AND THEREFORE ON THIS: the assignment-policy
-- outcomes rail (lib/analytics/assignment-outcomes.ts grades policies off
-- assignment_log), and `assignment_log.claimed`, which three live surfaces read
-- as "this handoff is still awaiting first touch" —
-- lib/intelligence/daily-briefing-generator.ts, lib/intelligence/isa-overnight.ts
-- (handoffs_unclaimed) and lib/intelligence/user-type-briefs/team-lead.ts.
-- A brokerage could not grade a routing policy it had no record of running.
--
-- ── WHAT THIS MIGRATION DOES, AND THE THING IT DELIBERATELY DOES NOT DO ──────
--
-- It ALIGNS the ledger to the ONE method vocabulary the other two columns
-- already share, and adds exactly two log-only owners that are methods in their
-- own right and cannot be spelled by the other two columns:
--
--   solo_agent   the solo tenant's single agent, chosen by TIER, ahead of every
--                setting (lib/lead-assignment/solo-agent.ts). Not a rule_type,
--                because it is not something a broker configures.
--   team_lead    the team's lead, the last rung of the team cascade when no
--                team member is routable (contact-assignment.ts:243, and the
--                lead-side twin added in this same lane).
--
-- It does NOT widen the ledger to admit the DECORATIONS. `default_load_balance`
-- and `geo_based_no_match` are not methods — they are a method plus attribution,
-- and admitting them would put the same method in the column under three
-- spellings, which is the drift this file exists to end. Attribution has a
-- column already: `assignment_log.routing_reason`, free text, previously never
-- written. The router now splits the decorated string in one place
-- (lib/lead-assignment/tier-routing.ts#normalizeAssignmentMethod) — method into
-- `assignment_method`, decoration into `routing_reason` — so nothing is lost and
-- the ledger stays one vocabulary. The postcondition below PROVES the decorated
-- spellings are still refused, so that normalization can never quietly stop
-- being required.
--
-- ORDER AND REPLAY SAFETY. There IS an old constraint governing this column
-- (assignment_log_assignment_method_check), so m486's repoint trap applies: the
-- old one is dropped by name and the new one added in the same transaction, and
-- section 1 MEASURES that no existing row would be orphaned by the change
-- (the new list is a strict SUPERSET of the old, so none can be — asserted
-- anyway, so a replay against a database that has since acquired rows under a
-- hand-edited constraint fails loudly instead of silently).

begin;

-- ── 1. MEASURED BEFORE ──────────────────────────────────────────────────────
do $$
declare
  v_old_def text;
  v_log_rows int;
  v_log_nonconforming int;
  v_leads_assigned int;
  v_rule_def text;
  v_default_def text;
begin
  select pg_get_constraintdef(oid) into v_old_def
    from pg_constraint
   where conrelid = 'public.assignment_log'::regclass
     and conname  = 'assignment_log_assignment_method_check';

  select pg_get_constraintdef(oid) into v_rule_def
    from pg_constraint
   where conrelid = 'public.assignment_rules'::regclass
     and conname  = 'assignment_rules_rule_type_check';

  select pg_get_constraintdef(oid) into v_default_def
    from pg_constraint
   where conrelid = 'public.brokerages'::regclass
     and conname  = 'brokerages_default_assignment_method_check';

  select count(*) into v_log_rows from public.assignment_log;
  select count(*) into v_leads_assigned from public.leads where agent_id is not null;

  -- Rows that the NEW list would not admit. Must be zero: the new list is a
  -- superset of the old, so this can only be non-zero if the constraint was
  -- hand-edited away at some point.
  select count(*) into v_log_nonconforming
    from public.assignment_log
   where assignment_method is not null
     and assignment_method not in (
       'round_robin','load_balance','geo_based','specialization','manual',
       'rule_match','ai_recommendation','solo_agent','team_lead'
     );

  raise notice 'm489 BEFORE: assignment_log CHECK = %', coalesce(v_old_def, '(none)');
  raise notice 'm489 BEFORE: assignment_rules.rule_type CHECK = %', coalesce(v_rule_def, '(none)');
  raise notice 'm489 BEFORE: brokerages.default_assignment_method CHECK = %', coalesce(v_default_def, '(none)');
  raise notice 'm489 BEFORE: assignment_log rows = %, leads carrying an agent_id = % (a ledger row is written for every one of those, so the gap is the silent loss)',
    v_log_rows, v_leads_assigned;

  if v_old_def is null then
    raise exception 'm489: assignment_log_assignment_method_check is missing — refusing to guess what it should replace';
  end if;

  if v_log_nonconforming > 0 then
    raise exception 'm489: % assignment_log rows carry a method outside the new list — repoint them before running this', v_log_nonconforming;
  end if;
end $$;

-- ── 2. DDL ──────────────────────────────────────────────────────────────────
alter table public.assignment_log
  drop constraint assignment_log_assignment_method_check;

alter table public.assignment_log
  add constraint assignment_log_assignment_method_check
  check (assignment_method = any (array[
    -- THE FIVE a broker configures — identical to assignment_rules.rule_type and
    -- brokerages.default_assignment_method. One vocabulary, three columns.
    'round_robin'::text,
    'load_balance'::text,
    'geo_based'::text,
    'specialization'::text,
    'manual'::text,
    -- LEDGER-ONLY. Not configurable, so not spellable in the other two columns.
    'rule_match'::text,       -- a rule decided, method unrecorded (legacy writers)
    'ai_recommendation'::text,-- the ISA proposed the agent
    'solo_agent'::text,       -- solo tier: the tenant's one agent, ahead of settings
    'team_lead'::text         -- team cascade's last rung: the team's lead
  ]));

-- ── 3. ASSERTED POSTCONDITIONS + REAL WRITE PROOF ───────────────────────────
do $$
declare
  v_brokerage uuid;
  v_lead uuid;
  v_log uuid;
  v_m text;
  v_refused boolean;
  v_new_def text;
begin
  select pg_get_constraintdef(oid) into v_new_def
    from pg_constraint
   where conrelid = 'public.assignment_log'::regclass
     and conname  = 'assignment_log_assignment_method_check';
  raise notice 'm489 AFTER: assignment_log CHECK = %', v_new_def;

  -- The alignment claim, asserted rather than asserted-in-prose: every value the
  -- other two columns admit must now be admitted here too.
  foreach v_m in array array['round_robin','load_balance','geo_based','specialization','manual'] loop
    if position(v_m in v_new_def) = 0 then
      raise exception 'm489: ledger still does not admit the configurable method %', v_m;
    end if;
  end loop;

  select id into v_brokerage from public.brokerages where deleted_at is null order by created_at limit 1;
  if v_brokerage is null then
    raise exception 'm489: no brokerage to prove a write against';
  end if;

  insert into public.leads (brokerage_id, first_name, last_name, source)
  values (v_brokerage, 'm489', 'Probe', 'manual')
  returning id into v_lead;

  -- REAL WRITE PROOF — every method the router can emit after normalization
  -- actually lands in the ledger. Before this migration three of these nine
  -- were refused and the refusal was invisible.
  foreach v_m in array array[
    'round_robin','load_balance','geo_based','specialization','manual',
    'rule_match','ai_recommendation','solo_agent','team_lead'
  ] loop
    insert into public.assignment_log (lead_id, brokerage_id, assignment_method, routing_reason)
    values (v_lead, v_brokerage, v_m, 'm489 probe')
    returning id into v_log;
    if v_log is null then
      raise exception 'm489: assignment_method = % does not land in the ledger', v_m;
    end if;
  end loop;

  -- And the half that matters just as much. Without these the constraint could
  -- be admitting everything and every assertion above would still pass.
  --
  -- A DECORATED spelling must be REFUSED: that is what forces the router to
  -- split method from attribution instead of stuffing both into one column.
  v_refused := false;
  begin
    insert into public.assignment_log (lead_id, brokerage_id, assignment_method)
    values (v_lead, v_brokerage, 'default_load_balance');
  exception when check_violation then v_refused := true;
  end;
  if not v_refused then
    raise exception 'm489: the ledger admits the decorated spelling default_load_balance — normalization is no longer enforced';
  end if;

  v_refused := false;
  begin
    insert into public.assignment_log (lead_id, brokerage_id, assignment_method)
    values (v_lead, v_brokerage, 'geo_based_no_match');
  exception when check_violation then v_refused := true;
  end;
  if not v_refused then
    raise exception 'm489: the ledger admits the decorated spelling geo_based_no_match';
  end if;

  v_refused := false;
  begin
    insert into public.assignment_log (lead_id, brokerage_id, assignment_method)
    values (v_lead, v_brokerage, 'whatever_the_router_felt_like');
  exception when check_violation then v_refused := true;
  end;
  if not v_refused then
    raise exception 'm489: the ledger admits arbitrary text';
  end if;

  delete from public.assignment_log where lead_id = v_lead;
  delete from public.leads where id = v_lead;

  raise notice 'm489: all NINE ledger methods PROVED to land (three of them could not before), and the decorated + arbitrary spellings PROVED to be refused (probe rows inserted then removed)';
end $$;

commit;
