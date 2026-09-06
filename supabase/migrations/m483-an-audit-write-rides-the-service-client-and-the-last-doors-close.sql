-- m483 — AN AUDIT WRITE RIDES THE SERVICE CLIENT, AND THE LAST DOORS CLOSE
-- (#180, INSERT stratum — the five tables m482 (D) left blocked).
--
-- m478 closed 119 tables, m482 closed 57 more and enumerated, in its (D)
-- section, the five it could NOT touch: their live consumer-session writers
-- rode the caller's RLS client with rows carrying no caller-linkable column,
-- so a staff-seat tightening would have silently dropped consumer writes.
-- Those writers have now MOVED APP-SIDE (same tree as this migration):
--
--   * app/actions/documents.ts — the portal document flows' SIX activities
--     audit writes (analyzeDocument, uploadDocument, processDocumentWithAI's
--     compliance-scan + analysis rows, getDocumentWithAnalysis's view log,
--     askDocumentQuestion) now ride createServiceClient() AFTER the existing
--     access checks (getAgentContext + tenant check, or the caller's-own-RLS
--     document read that precedes each audit row). The DOCUMENT writes kept
--     their original clients; only the audit rows moved. All six also stopped
--     stuffing a brokerages.id into agent_id (FK → agents.id, refused 23503
--     and swallowed) and now destructure + log their error.
--   * lib/errors/collect-error.ts — the ONE writer of automation_errors /
--     error_stack_traces / error_resolution_log now DEFAULTS to the service
--     client (error intake is post-authorization audit: the route
--     app/api/errors/collect/route.ts gates on INTERNAL_API_SECRET or an
--     authenticated session before calling it). lib/errors/auto-retry.ts
--     (same pattern, plus a cron caller that never had a session at all)
--     moved with it.
--   * lib/services/communication.service.tsx — the message_provider_logs
--     audit writes (sendEmail / sendSMS) and logCommunication's audit rows
--     ride the service client; the service is reachable from consumer
--     sessions (app/actions/calculators.ts:1612,
--     app/actions/collaborative-search.ts:221).
--
-- RE-MEASURED LIVE for this migration (2026-08-18, pg_policies on project
-- hrvaqgvukzxfskkcrwbt) and RE-VERIFIED writer-by-writer against the CURRENT
-- tree (post the app moves above). Per-table census — every remaining
-- RLS-client INSERT writer, and why the seat test costs it nothing:
--
--   activities
--     TWO permissive INSERT policies (measured):
--       activities_tenant_insert   WITH CHECK (brokerage_id = current_user_brokerage_id())
--       activities_insert_own      WITH CHECK (agent_id IN (SELECT agents.id
--                                    FROM agents WHERE agents.user_id = auth.uid()))
--     The second is TENANT-FREE — an agent seat could stamp any brokerage_id
--     onto a row carrying their own agents.id, and the tenant policy's pin
--     would never be consulted (permissive policies OR). It is rebuilt below
--     with the SAME own-row test AND the brokerage pin, refusing loudly if its
--     live with_check differs from the measured text. Remaining RLS-client
--     writers after the documents.ts move, resolved by hand:
--       · staff dashboard/action surfaces (app/actions/error-handler.ts:87,121;
--         app/actions/showings.ts:218 from CRM/properties surfaces;
--         lib/security/rbac.ts; lib/approval-workflow/approval-logger.ts;
--         lib/content-generation/generation-logger.ts;
--         app/actions/cma-presentation/*, app/actions/voice-call-bridge.ts,
--         app/actions/credit-copilot.ts via app/credit-pipeline — all agent /
--         admin sessions, which is_tenant_staff_seat() admits).
--       · app/actions/showings.ts:218 is ALSO importable from the buyer portal
--         (app/components/portal/PersonaPropertiesDashboard.tsx:24) — but that
--         lane cannot reach the activities write on a consumer seat: the SAME
--         action's showing_requests insert at showings.ts:149 was staff-seat
--         tightened by m482(A) and refuses the consumer session first (the
--         action returns its error at :179-181). No consumer write that lands
--         TODAY is dropped by this tightening. The voice-webhook lane passes a
--         caller-verified service client and bypasses RLS entirely.
--       · every portal/widget/service lane rides createServiceClient()
--         (contact-vendor-booking.ts:125, portal-stream.ts:247,
--         lib/buyer-*/, lib/kernel/*, communication.service.tsx after the move).
--
--   automation_errors
--     Writers: lib/errors/collect-error.ts (service default, post-move) + the
--     20 baselined direct inserts (scripts/automation-error-baseline.json) —
--     19 of 20 build createServiceClient() (verified file-by-file); the one
--     RLS-client site, lib/lead-pipeline/pipeline-processor.ts:588, is reached
--     only from app/actions/scrape-social-media.ts (staff surface — agent
--     session, seat test passes) and app/api/cron/lead-scraping (sessionless:
--     its RLS client is anon TODAY, already outside the authenticated-only
--     policy — the seat test changes nothing there).
--
--   error_stack_traces
--     ONE writer: lib/errors/collect-error.ts:119 (service default, post-move).
--
--   error_resolution_log
--     Writers: lib/errors/collect-error.ts:139 + lib/errors/auto-retry.ts
--     (service, post-move) and app/api/errors/escalate/route.ts:71 — an
--     RLS-client write behind that route's OWN admin/broker gate
--     (isAdminOrBroker or platform superadmin), i.e. a staff seat by
--     construction: the seat test admits it.
--
--   message_provider_logs
--     Writers: lib/services/communication.service.tsx:~110/150 (service,
--     post-move); all other insert sites already rode service —
--     app/actions/social-dm.ts:176, app/actions/ai-communication-hub.ts:238,
--     lib/campaign-sequences/step-executor.ts:492,
--     lib/ai-isa/direct-mail-trigger.ts:134.
--
-- is_tenant_staff_seat() is NOT redefined here — m475 owns it. UPDATE/DELETE
-- policies are out of scope: this is the INSERT stratum only.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. GLOBAL PRECONDITIONS. The helpers this migration leans on must already
--    exist (m475 / the tenancy baseline); creating them here would be
--    claiming ownership this migration does not have.
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_tenant_staff_seat'
  ) then
    raise exception 'm483: public.is_tenant_staff_seat() does not exist — m475 must land first, refusing';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'current_user_brokerage_id'
  ) then
    raise exception 'm483: public.current_user_brokerage_id() does not exist — the tenancy baseline is missing, refusing';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. activities — pin the tenant onto the second permissive policy FIRST.
--    activities_insert_own admitted (agent_id ∈ caller's own agents) with NO
--    brokerage test: because permissive policies OR together, that let an
--    agent seat write a row stamped with ANY brokerage_id, sidestepping the
--    tenant policy entirely. Rebuilt as (same own-row test) AND (brokerage
--    pin). The own-row test is compared VERBATIM against the live expression
--    measured 2026-08-18 — anything else means the policy moved since, and
--    this migration refuses rather than rewrite someone else's rule blind.
do $$
declare
  v_measured_own constant text := E'(agent_id IN ( SELECT agents.id\n   FROM agents\n  WHERE (agents.user_id = auth.uid())))';
  r record;
  v_count int;
begin
  -- Exactly the two measured INSERT policies, no strays.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public' and cmd = 'INSERT' and tablename = 'activities';
  if v_count <> 2 then
    raise exception 'm483(activities): expected exactly 2 INSERT policies (tenant + own), found % — the ground shifted, refusing', v_count;
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and cmd = 'INSERT' and tablename = 'activities'
      and policyname not in ('activities_tenant_insert','activities_insert_own')
  ) then
    raise exception 'm483(activities): an INSERT policy other than activities_tenant_insert / activities_insert_own exists — refusing';
  end if;

  select tablename, policyname, with_check into r
  from pg_policies
  where schemaname = 'public' and cmd = 'INSERT'
    and tablename = 'activities' and policyname = 'activities_insert_own';
  if r.policyname is null then
    raise exception 'm483(activities): activities_insert_own not found — refusing';
  end if;
  if r.with_check is distinct from v_measured_own then
    raise exception 'm483(activities): activities_insert_own with_check no longer matches the measured own-row expression — it reads %, refusing to rewrite a policy that changed since the census', r.with_check;
  end if;

  drop policy "activities_insert_own" on public.activities;
  execute format(
    'create policy %I on public.activities for insert to authenticated with check ((%s) and (brokerage_id = public.current_user_brokerage_id()))',
    'activities_insert_own', v_measured_own);
  raise notice 'm483(activities): activities_insert_own rebuilt with the tenant pin';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. activities_tenant_insert + the four single-policy tables — append the
--    seat test, m478/m482 style: per-policy preconditions (a tenant pin must
--    be present, no identity/role test may already be there), literal count.
do $$
declare
  v_tables constant text[] := array[
        'activities','automation_errors','error_stack_traces',
        'error_resolution_log','message_provider_logs'
  ];
  r record;
  n int := 0;
  v_stray int;
begin
  -- Precondition: besides the five <table>_tenant_insert policies, the ONLY
  -- other INSERT policy on these tables is the activities_insert_own policy
  -- step 1 just tenant-pinned. Anything else landed since the census — stop
  -- and re-measure rather than tighten beside an unknown door.
  select count(*) into v_stray
  from pg_policies
  where schemaname = 'public'
    and cmd = 'INSERT'
    and tablename = any(v_tables)
    and policyname <> tablename || '_tenant_insert'
    and not (tablename = 'activities' and policyname = 'activities_insert_own');
  if v_stray <> 0 then
    raise exception 'm483: % unexpected extra INSERT policies on the five tables — the ground shifted, refusing', v_stray;
  end if;

  for r in
    select tablename, policyname, with_check
    from pg_policies
    where schemaname = 'public'
      and cmd = 'INSERT'
      and tablename = any(v_tables)
      and policyname = tablename || '_tenant_insert'
  loop
    if r.with_check is null or r.with_check !~ 'brokerage_id' then
      raise exception 'm483: %.% has no brokerage_id pin in with_check — not the measured stratum, refusing', r.tablename, r.policyname;
    end if;
    if r.with_check ~ 'user_type|is_brokerage|is_platform|is_tenant_staff_seat|is_team_lead|auth\.uid|jwt' then
      raise exception 'm483: %.% already carries an identity test — refusing to rewrite blind', r.tablename, r.policyname;
    end if;
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
    execute format(
      'create policy %I on public.%I for insert with check ((%s) and public.is_tenant_staff_seat())',
      r.policyname, r.tablename, r.with_check);
    n := n + 1;
  end loop;
  raise notice 'm483: tightened % tenant INSERT policies', n;
  -- Exactly one bare-tenant INSERT policy per listed table, verified live
  -- before authoring: 5 tables, 5 policies.
  if n <> 5 then
    raise exception 'm483: expected exactly 5 tenant policies across 5 tables, rewrote %', n;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- POSTCONDITIONS. Stated literally, then verified:
--   * All 5 rewritten <table>_tenant_insert policies carry is_tenant_staff_seat().
--   * activities_insert_own carries BOTH the own-row test and the tenant pin.
--   * activities ends with exactly 2 INSERT policies; each of the other four
--     tables ends with exactly 1.
do $$
declare
  v_tables constant text[] := array[
        'activities','automation_errors','error_stack_traces',
        'error_resolution_log','message_provider_logs'
  ];
  v_bad int;
begin
  select count(*) into v_bad
  from pg_policies
  where schemaname = 'public'
    and cmd = 'INSERT'
    and tablename = any(v_tables)
    and policyname = tablename || '_tenant_insert'
    and coalesce(with_check, qual) !~ 'is_tenant_staff_seat';
  if v_bad <> 0 then
    raise exception 'm483: % tenant INSERT policies remain without the seat test', v_bad;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and cmd = 'INSERT'
      and tablename = 'activities' and policyname = 'activities_insert_own'
      and with_check ~ 'agents\.user_id = auth\.uid'
      and with_check ~ 'current_user_brokerage_id'
  ) then
    raise exception 'm483: activities_insert_own is missing its own-row test or its tenant pin';
  end if;

  if (select count(*) from pg_policies
      where schemaname = 'public' and cmd = 'INSERT' and tablename = 'activities') <> 2 then
    raise exception 'm483: activities should end with exactly 2 INSERT policies';
  end if;

  select count(*) into v_bad
  from pg_policies
  where schemaname = 'public' and cmd = 'INSERT'
    and tablename = any(array['automation_errors','error_stack_traces',
                              'error_resolution_log','message_provider_logs']);
  if v_bad <> 4 then
    raise exception 'm483: the four single-policy tables should end with exactly 4 INSERT policies, found %', v_bad;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS DELIBERATELY DOES NOT DO:
--   * No app write moves here — those landed in the same tree (documents.ts,
--     collect-error.ts, auto-retry.ts, communication.service.tsx,
--     lender-portal-actions.ts) and this migration assumes them.
--   * client_portal_messages' vendor lane (has_vendor_seat, m482 (B)) is NOT
--     narrowed here even though lender-portal-actions.ts now stamps
--     transaction_id on both lender writes — that narrowing is m482's
--     successor's to make on fresh evidence, not a rider on this one.
--   * The 9 already-guarded tables from the 71-policy stratum (m482 header)
--     stay untouched.
