-- m390 — the POLICY side of "THE NAME WAS THE BUG".
--
-- m350 renamed the COLUMNS whose name lied (agent_id holding a users.id →
-- agent_user_id), across five batches, because "195 columns in this schema are
-- called agent_id; 175 FK agents(id), 20 FK users(id)... reading one as the other
-- never degrades — it silently matches nothing."
--
-- Nobody ever swept the POLICIES. 22 of them compare `agent_id = auth.uid()`
-- where the column is a FOREIGN KEY TO agents and auth.uid() is a users.id.
-- Verified column by column against information_schema before touching anything:
-- every table rewritten below FKs agents(id). The clause is CONSTANT-FALSE, so
-- every one of these "owner can see their own" paths has never worked once:
--
--   an agent could not read their own certifications, learning paths or
--   performance reports; their own buyer behaviour log, fatigue scores or
--   property preferences; their own CDA or its comparison results; the chat
--   messages, conversation insights, conversation logs or property-alert results
--   for their own contacts; or the compliance alerts, compliance checklists and
--   TRID timeline for their own transactions.
--
-- Two of the policies (bbl_agent_own, bfs_agent_own) consist of NOTHING BUT that
-- clause, so they granted exactly nothing, always.
--
-- THE REWRITE IS TEXT-PRESERVING BY CONSTRUCTION. Each policy is re-created from
-- its OWN current expression with only the substring `agent_id = auth.uid()`
-- replaced by `agent_id = current_user_agent_id()`. Every other clause — the
-- broker/admin branches, the team-lead joins, the super_admin escapes — is
-- carried across byte-for-byte by pg_get_expr round-tripping, rather than being
-- retyped by hand across 22 policies. Each rewrite RAISES if the policy is
-- missing or does not contain the expected clause, so a drifted schema stops the
-- migration instead of silently rewriting something else.
--
-- current_user_agent_id() is the resolver the rest of the schema already uses
-- (033-auth-helper-functions.sql): SELECT id FROM agents WHERE user_id =
-- auth.uid(), SECURITY DEFINER STABLE, granted to authenticated. This RESOLVES
-- between the two id spaces instead of coalescing them, which is the standing
-- rule for agents.id / users.id / contacts.id everywhere in this codebase.
--
-- DELIBERATELY EXCLUDED: podcast_show_settings and scheduled_touchpoints. Their
-- agent_id carries NO foreign key, so the class cannot be proven from the schema
-- and a guess is exactly what this migration exists to stop. Recorded, not
-- silently swept.
--
-- Pre-rollout every one of these tables is EMPTY, so this widens no existing
-- row's visibility. It restores access paths that were dead on arrival.
do $$
declare
  r          record;
  new_qual   text;
  new_check  text;
  targets    text[][] := array[
    ['agent_certifications',          'Agent certifications viewable by owner or admin'],
    ['agent_certifications',          'agent_certifications_all'],
    ['agent_learning_paths',          'agent_learning_paths_all'],
    ['agent_performance_reports',     'agent_performance_reports_all'],
    ['buyer_behavior_log',            'bbl_agent_own'],
    ['buyer_behavior_log',            'buyer_behavior_log_access'],
    ['buyer_behavior_predictions',    'buyer_behavior_predictions_access'],
    ['buyer_fatigue_scores',          'bfs_agent_own'],
    ['buyer_fatigue_scores',          'buyer_fatigue_scores_access'],
    ['cda_comparison_results',        'agent_select_own_cda_comparison'],
    ['chat_messages',                 'Users read own contact chat messages'],
    ['chat_messages',                 'users_read_own_chat_messages'],
    ['closing_disclosure_agreement',  'agent_crud_own_cda'],
    ['compliance_alerts',             'Compliance alerts viewable by transaction access'],
    ['compliance_checklists',         'Compliance checklists viewable by transaction access'],
    ['conversation_insights',         'Users can view insights for their conversations'],
    ['conversation_logs',             'conversation_logs_agent_policy'],
    ['property_alert_results',        'Agents see results for their buyers'],
    ['property_preferences',          'pp_agent_own'],
    ['property_preferences',          'property_preferences_access'],
    ['trid_timeline',                 'TRID timeline viewable by transaction access']
  ];
  i int;
begin
  for i in 1 .. array_length(targets, 1) loop
    select c.relname            as tbl,
           p.polname            as polname,
           p.polcmd             as cmd,
           pg_get_expr(p.polqual,      p.polrelid) as qual,
           pg_get_expr(p.polwithcheck, p.polrelid) as wcheck,
           array(select rolname from pg_roles where oid = any(p.polroles)) as roles
      into r
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname  = targets[i][1]
       and p.polname  = targets[i][2];

    if not found then
      raise exception 'm390: policy %.% not found — refusing to continue', targets[i][1], targets[i][2];
    end if;

    new_qual  := replace(r.qual,   'agent_id = auth.uid()', 'agent_id = current_user_agent_id()');
    new_check := replace(coalesce(r.wcheck, ''), 'agent_id = auth.uid()', 'agent_id = current_user_agent_id()');

    if new_qual = r.qual then
      raise exception 'm390: %.% did not contain the expected clause — refusing to rewrite it blind',
        targets[i][1], targets[i][2];
    end if;

    execute format('drop policy %I on public.%I', r.polname, r.tbl);
    execute format(
      'create policy %I on public.%I as permissive for %s to %s using (%s)%s',
      r.polname,
      r.tbl,
      case r.cmd when 'r' then 'select' when 'a' then 'insert'
                 when 'w' then 'update' when 'd' then 'delete' else 'all' end,
      case when array_length(r.roles, 1) is null then 'public'
           else (select string_agg(quote_ident(x), ', ') from unnest(r.roles) x) end,
      new_qual,
      case when r.wcheck is null then '' else format(' with check (%s)', new_check) end
    );
  end loop;
end $$;
