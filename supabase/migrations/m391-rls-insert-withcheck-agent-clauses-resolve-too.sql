-- m391 — the two m390 missed, and why it missed them.
--
-- m390 selected its targets by scanning `polqual` (the USING expression). An
-- INSERT policy has NO using expression — its whole rule lives in WITH CHECK —
-- so two policies carrying the identical defect were never in the target list.
-- Found by VERIFYING the sweep afterwards instead of trusting its count: 21
-- rewritten, but five still matching, of which three are the documented
-- exclusions and two were simply missed.
--
--   chat_messages     "Users insert into own contact chat sessions"
--   conversation_logs conversation_logs_insert_policy
--
-- Same class as m390: both compare an agents-FK column to auth.uid() (a
-- users.id), so both are constant-false. An agent could not insert a chat
-- message for their own contact, nor write a conversation log — the WRITE side
-- of the same access the read side was already denied.
--
-- STILL EXCLUDED, deliberately: podcast_show_settings (2 policies) and
-- scheduled_touchpoints (1). Their agent_id carries no foreign key, so the id
-- class cannot be established from the schema and rewriting them would be the
-- guess this whole line of work exists to eliminate. They are named here rather
-- than left as an unexplained remainder.
do $$
declare
  r         record;
  new_check text;
  targets   text[][] := array[
    ['chat_messages',     'Users insert into own contact chat sessions'],
    ['conversation_logs', 'conversation_logs_insert_policy']
  ];
  i int;
begin
  for i in 1 .. array_length(targets, 1) loop
    select c.relname as tbl, p.polname, p.polcmd as cmd,
           pg_get_expr(p.polwithcheck, p.polrelid) as wcheck,
           array(select rolname from pg_roles where oid = any(p.polroles)) as roles
      into r
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname='public' and c.relname = targets[i][1] and p.polname = targets[i][2];

    if not found then
      raise exception 'm391: policy %.% not found', targets[i][1], targets[i][2];
    end if;

    new_check := replace(r.wcheck, 'agent_id = auth.uid()', 'agent_id = current_user_agent_id()');
    if new_check = r.wcheck then
      raise exception 'm391: %.% did not contain the expected clause', targets[i][1], targets[i][2];
    end if;

    execute format('drop policy %I on public.%I', r.polname, r.tbl);
    execute format(
      'create policy %I on public.%I as permissive for insert to %s with check (%s)',
      r.polname, r.tbl,
      case when array_length(r.roles,1) is null then 'public'
           else (select string_agg(quote_ident(x), ', ') from unnest(r.roles) x) end,
      new_check
    );
  end loop;
end $$;
