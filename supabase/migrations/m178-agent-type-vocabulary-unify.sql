-- m178 — Wave 39: unify the conversational-routing agent_type vocabulary.
--
-- The multi-agent CONVERSATION-ROUTING plane (distinct from the managed-agent
-- runtime plane: deal_coordinator/shopping_agent/…) had FOUR slightly different
-- spellings of its agent-type enum across tables + the code registry:
--   agent_coordination_log.agent_type : isa/tc/coaching/content/router      (no human/none)
--   agent_handoffs.from/to_agent_type : isa/tc/coaching/content/router/human (no none)
--   agent_state_machine.current_agent : isa/tc/coaching/content/human/none   (no router)
--   code VALID_AGENT_TYPES            : isa/tc/coaching/content/human        (no router/none)
--
-- No live crash (the router defensively guards human/none), but the divergence
-- is exactly the drift we are eliminating. Unify all table constraints onto the
-- canonical SUPERSET so a value valid in one place is valid everywhere; the
-- application logic still decides which subset is meaningful per context.
--
--   Canonical actors (conversation-routing plane):
--     isa_agent       — AI inside-sales agent: follows up + qualifies leads
--     tc_agent        — AI transaction-coordinator assistant (aids the human TC)
--     coaching_agent  — AI role-play / coaching
--     content_agent   — AI content generation
--     router          — the dispatcher itself
--     human           — a human real-estate agent (handoff target)
--     none            — unassigned
--
-- Additive widening — no existing row can break.

do $$
declare
  canonical text := 'array[''isa_agent'',''tc_agent'',''coaching_agent'',''content_agent'',''router'',''human'',''none'']';
  targets   text[][] := array[
    ['agent_coordination_log','agent_type'],
    ['agent_handoffs','from_agent_type'],
    ['agent_handoffs','to_agent_type'],
    ['agent_state_machine','current_agent']
  ];
  i int;
  tbl text; col text; cname text;
begin
  for i in 1 .. array_length(targets,1) loop
    tbl := targets[i][1];
    col := targets[i][2];
    for cname in
      select conname from pg_constraint
      where conrelid = format('public.%I', tbl)::regclass and contype='c'
        and pg_get_constraintdef(oid) like '%'||col||'%'
    loop
      execute format('alter table public.%I drop constraint %I', tbl, cname);
    end loop;
    execute format(
      'alter table public.%I add constraint %I_%I_check check (%I = any (%s))',
      tbl, tbl, col, col, canonical);
  end loop;
end $$;
