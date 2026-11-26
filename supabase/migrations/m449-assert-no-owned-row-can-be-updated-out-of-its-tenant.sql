-- m449 — asserts m448.
--
-- ── CLAIM 1 — THE FIVE OWNERSHIP UPDATES HOLD THEIR ROW IN TENANT (HARD) ────
--
-- Each of these establishes ownership and, before m448, named no tenant at all,
-- on a table that has one. With no WITH CHECK, Postgres reuses USING — which
-- answers "which rows may I act on", never "what may this row become" — so the
-- owner could rewrite brokerage_id to any brokerage and still pass, because they
-- were still the owner. Proved live: an agent moved one of their own contacts,
-- with its PII and TCPA consent, into another brokerage.
do $$
declare
  targets text[][] := array[
    ['contacts',                  'agent_update_own_contacts'],
    ['activities',                'activities_update_own'],
    ['learning_assignments',      'la_self_update'],
    ['push_subscriptions',        'push_subs_update_own'],
    ['video_completion_tracking', 'vct_update']
  ];
  i int; chk text; usg text; n int := 0; offenders text := '';
begin
  for i in 1 .. array_length(targets, 1) loop
    select pg_get_expr(p.polwithcheck, p.polrelid), pg_get_expr(p.polqual, p.polrelid)
      into chk, usg
      from pg_policy p
      join pg_class     c  on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname='public' and c.relname=targets[i][1] and p.polname=targets[i][2];

    if usg is null then
      raise exception
        'm449: %.% is gone. m448 AMENDED it rather than dropping it — the capability (an owner editing their own row) is the point, and deleting the policy removes a working write instead of a defect.',
        targets[i][1], targets[i][2];
    end if;

    -- The row must be held in tenant by SOMETHING: either an explicit WITH CHECK
    -- carrying the anchor, or a USING that names it (which Postgres then reuses).
    -- The construct is "the new row cannot leave", not a particular spelling.
    if coalesce(chk,'') !~ '(has_brokerage_access|brokerage_id)'
       and usg !~ '(has_brokerage_access|brokerage_id)' then
      n := n + 1;
      offenders := offenders || format('  %s.%s  →  check=%s', targets[i][1], targets[i][2], coalesce(chk,'<absent, USING reused>')) || chr(10);
    end if;
  end loop;

  if n > 0 then
    raise exception
      'm449: % ownership UPDATE polic(ies) can move their row into another tenant again. When WITH CHECK is absent Postgres reuses USING, and a USING that only proves OWNERSHIP does not stop the owner rewriting brokerage_id. On contacts that carries a person''s PII and their TCPA consent out of the brokerage. State the WITH CHECK and put the tenant in it.%',
      n, chr(10) || offenders;
  end if;
end $$;

-- ── CLAIM 2 — THE FIX STAYED SUBTRACTIVE (HARD) ────────────────────────────
--
-- m448 amended only WITH CHECK and left every USING byte-identical, so no caller
-- lost a row they could already edit. Verified live: the same agent editing the
-- same contact inside its own tenant still succeeds. If a later edit narrows a
-- USING here, an owner silently stops being able to edit their own row — a
-- refusal that looks like "no rows" and reports nothing.
do $$
declare
  targets text[][] := array[
    ['contacts',                  'agent_update_own_contacts',  'agents'],
    ['activities',                'activities_update_own',      'agents'],
    ['learning_assignments',      'la_self_update',             'auth.uid'],
    ['push_subscriptions',        'push_subs_update_own',       'auth.uid'],
    ['video_completion_tracking', 'vct_update',                 'agents']
  ];
  i int; usg text;
begin
  for i in 1 .. array_length(targets, 1) loop
    select pg_get_expr(p.polqual, p.polrelid) into usg
      from pg_policy p
      join pg_class     c  on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname='public' and c.relname=targets[i][1] and p.polname=targets[i][2];

    if usg !~ targets[i][3] then
      raise exception
        'm449: %.% no longer establishes OWNERSHIP through %. m448 was deliberately subtractive — it amended WITH CHECK only and left USING untouched — so a change here means the owner''s own write has been narrowed, which surfaces as an empty result and no error. USING now: %',
        targets[i][1], targets[i][2], targets[i][3], usg;
    end if;
  end loop;
end $$;

-- ── CLAIM 3 — THE REMAINING CENSUS, NAMED (WARNING) ────────────────────────
--
-- After m446 and m448 the only member of this class left is
-- conversation_audit_flags, and it is a different defect: a bare role test on a
-- table with NO tenant column at all, so there is nothing to move and nothing to
-- anchor to. It needs a schema ruling, not a policy edit.
do $$
declare n int; t int; lst text := '';
declare r record;
begin
  for r in
    select tablename, policyname from pg_policies
    where schemaname='public' and cmd='UPDATE' and with_check is null
      and 'service_role' <> all(roles)
      and coalesce(qual,'') !~ '(brokerage_id|tenant_id|organization_id|has_brokerage_access|current_user_brokerage_id)'
    order by tablename, policyname
  loop
    lst := lst || format('  %s.%s', r.tablename, r.policyname) || chr(10);
  end loop;

  select count(*), count(distinct tablename) into n, t from pg_policies
   where schemaname='public' and cmd='UPDATE' and with_check is null
     and 'service_role' <> all(roles)
     and coalesce(qual,'') !~ '(brokerage_id|tenant_id|organization_id|has_brokerage_access|current_user_brokerage_id)';

  if n > 0 then
    raise warning
      'm449: % UPDATE polic(ies) across % table(s) still have no WITH CHECK and no tenant term in USING. Named so the number cannot become folklore:%',
      n, t, chr(10) || lst;
  else
    raise notice 'm449: no UPDATE policy in public lacks both a WITH CHECK and a tenant term in its USING.';
  end if;
end $$;

do $$
begin
  raise notice 'm449: all hard claims hold — the five ownership UPDATEs hold their row inside its tenant, and every one of them still lets its owner edit it.';
end $$;
