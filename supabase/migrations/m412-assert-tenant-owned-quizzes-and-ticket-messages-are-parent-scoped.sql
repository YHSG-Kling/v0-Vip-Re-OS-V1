-- m412 — ASSERTION for m411. Separate file because a `raise` rolls back its own
-- transaction, so the change (m411) and the proof (m412) cannot share one.
--
-- Asserts the CONSTRUCT out of pg_policy, never a name spelling: what the policy
-- expressions actually reference and which roles they are granted to.

do $$
declare
  n int;
  bad text;
begin
  -- ── onboarding_quizzes ────────────────────────────────────────────────────

  -- 1. No policy may admit every row unconditionally. `oq_select USING (true)`
  --    granted to PUBLIC is what let an UNAUTHENTICATED caller read every quiz's
  --    `questions` jsonb — correctAnswer included — for every tenant.
  select string_agg(polname, ', ') into bad
  from pg_policy
  where polrelid = 'public.onboarding_quizzes'::regclass
    and btrim(coalesce(pg_get_expr(polqual, polrelid), '')) = 'true';
  if bad is not null then
    raise exception 'onboarding_quizzes still has an unconditional USING(true) policy: %', bad;
  end if;

  -- 2. No policy on the table may be granted to PUBLIC (polroles = {0}), which
  --    includes anon. Tenancy is inherited from the parent step, and the parent's
  --    own policies are TO authenticated — a PUBLIC policy here would out-reach them.
  select string_agg(polname, ', ') into bad
  from pg_policy
  where polrelid = 'public.onboarding_quizzes'::regclass
    and 0 = any (polroles);
  if bad is not null then
    raise exception 'onboarding_quizzes policy granted to PUBLIC: %', bad;
  end if;

  -- 3. All four commands must be covered. A missing command is a default-DENY,
  --    which is how the tenant could never author a quiz for its own step.
  select count(distinct polcmd) into n
  from pg_policy where polrelid = 'public.onboarding_quizzes'::regclass
    and polcmd in ('r','a','w','d');
  if n <> 4 then
    raise exception 'onboarding_quizzes covers % of 4 commands (r/a/w/d)', n;
  end if;

  -- 4. EVERY policy must constrain through the parent onboarding_steps row.
  --    onboarding_quizzes has no brokerage_id of its own, so this join IS its
  --    tenancy. A policy that does not reference the parent cannot be scoped.
  select string_agg(polname, ', ') into bad
  from pg_policy
  where polrelid = 'public.onboarding_quizzes'::regclass
    and coalesce(pg_get_expr(polqual, polrelid), '') || coalesce(pg_get_expr(polwithcheck, polrelid), '')
        not like '%onboarding_steps%';
  if bad is not null then
    raise exception 'onboarding_quizzes policy does not constrain through its parent step: %', bad;
  end if;

  -- 5. The three WRITE policies must additionally pin the parent to the caller's
  --    OWN tenant. Reading a platform quiz is shared; writing one is not.
  select string_agg(polname, ', ') into bad
  from pg_policy
  where polrelid = 'public.onboarding_quizzes'::regclass
    and polcmd in ('a','w','d')
    and coalesce(pg_get_expr(polqual, polrelid), '') || coalesce(pg_get_expr(polwithcheck, polrelid), '')
        not like '%current_user_brokerage_id%';
  if bad is not null then
    raise exception 'onboarding_quizzes write policy has no tenant predicate on the parent: %', bad;
  end if;

  -- ── support_ticket_messages ───────────────────────────────────────────────

  -- 6. INSERT must exist and must constrain through the parent ticket. Before
  --    m411 the table carried exactly ONE policy (FOR SELECT), so posting a
  --    reply on the RLS-bound client was default-DENIED and only the
  --    service-role rail could write the thread at all.
  select count(*) into n
  from pg_policy
  where polrelid = 'public.support_ticket_messages'::regclass
    and polcmd = 'a'
    and coalesce(pg_get_expr(polwithcheck, polrelid), '') like '%support_tickets%';
  if n < 1 then
    raise exception 'support_ticket_messages has no INSERT policy scoped through support_tickets';
  end if;

  -- 7. The read must admit platform staff, matching what m406 gave the parent
  --    (support_tickets_tenant_select = is_platform_admin() OR own tenant).
  --    Without it the platform support console can read a ticket but not its
  --    thread on the RLS rail.
  select count(*) into n
  from pg_policy
  where polrelid = 'public.support_ticket_messages'::regclass
    and polcmd = 'r'
    and coalesce(pg_get_expr(polqual, polrelid), '') like '%is_platform_admin%';
  if n < 1 then
    raise exception 'support_ticket_messages SELECT does not admit is_platform_admin()';
  end if;

  raise notice 'm412 OK: quizzes and ticket messages are parent-scoped.';
end $$;
