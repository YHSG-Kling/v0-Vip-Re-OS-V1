-- m482 — A PORTAL WRITE NAMES ITS OWN SEAT (#180, final INSERT stratum).
--
-- m478 closed 119 staff/service-only tables by appending is_tenant_staff_seat()
-- to their bare-tenant INSERT policies. The census that authored m478 left a
-- remainder it called portal-written or uncertain. That remainder was
-- RE-MEASURED LIVE for this migration (2026-08-18, pg_policies on project
-- hrvaqgvukzxfskkcrwbt) with m478's own stratum regex
--   cmd='INSERT' AND with_check ~ 'brokerage_id'
--   AND with_check !~ 'user_type|is_brokerage|is_platform|is_tenant_staff_seat|is_team_lead|auth\.uid|jwt'
-- and measures 71 policies on 71 tables today (the census said 72; the tree has
-- moved since — m479/m480/m481 landed usage, tours and contracts work — and one
-- census row is no longer in the stratum; every table treated here was
-- re-verified against pg_policies and against the CURRENT tree, writer by
-- writer, before its policy was touched).
--
-- Of the 71:
--   * 9 are regex artifacts, not bare-tenant: their predicates carry identity /
--     own-row tests spelled with functions the regex does not know
--     (has_brokerage_access + role tests, can_access_support_ticket,
--     can_write_service_area, portal_member_searches, can_read_brokerage_books).
--     LEFT UNTOUCHED — never rewrite someone else's rule blind:
--       closing_disclosure_agreement  (compliance-officer test)
--       collaborative_search_members  (portal_member_searches own-row)
--       collaborative_search_properties (portal_member_searches own-row)
--       open_house_analytics          (oha_ins pins via parent event; writer is
--                                      app/actions/open-house-automation.ts —
--                                      service client)
--       property_consensus            (portal_member_searches own-row)
--       subscriber_service_areas      (can_write_service_area grain gate)
--       support_ticket_messages       (can_access_support_ticket lane gate)
--       support_tickets               (can_access_support_ticket lane gate)
--       transactions                  (books/tc role test)
--   * 62 are genuinely bare-tenant. They split, ON FRESH WRITER EVIDENCE, into:
--       (A) 50 STAFF/SERVICE-ONLY — every portal/widget/public writer rides
--           createServiceClient() (service role bypasses RLS) or the table has
--           only staff-surface writers. The seat test costs those flows nothing
--           and closes the client-seat door. Same treatment as m478.
--       (B) 5 GENUINELY CONTACT/LENDER/VENDOR-WRITTEN with the caller's own
--           RLS client — rewritten as COMPOUND policies:
--           (original tenant pin) AND (is_tenant_staff_seat() OR own-row).
--       (C) 2 DOUBLE-POLICY tables (chat_sessions, vendor_usage_tracking)
--           whose second permissive WITH CHECK (true) INSERT policy is DEAD
--           (measured: every writer on its lane is the service client, which
--           never consults it) — the dead policy is dropped and the tenant
--           policy tightened like (A).
--       (D) 5 LEFT UNTOUCHED because no defensible own-row test can be stated
--           for their live consumer-session writers — enumerated at the bottom
--           of this file with the app-side fix each one is waiting on.
--   50 + 5 + 2 + 5 = 62.  62 + 9 = 71 = the whole measured stratum.
--
-- is_tenant_staff_seat() is NOT redefined here — m475 owns it.
-- UPDATE/DELETE policies are out of scope: this is the INSERT stratum only.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. OWN-ROW PREDICATES FOR THE (B) TABLES.
--    Three new SECURITY DEFINER helpers, derived from the app's own
--    authorization rails (not invented):
--      · is_own_agent_user_id(p_user_id): the caller is a contact and p_user_id
--        is THEIR OWN agent's users.id — the exact link the portal walks when a
--        client lights their agent's bell (app/portal/[contactId]/layout.tsx:195-207
--        reads contacts.agent_id → agents.user_id; app/actions/journey-tasks.ts:436-457
--        resolves the same pair via resolveAgentRecordToUserId).
--      · is_assigned_vendor_on_transaction(p_transaction_id): the caller holds a
--        vendor seat (user_role_assignments.vendor_id) whose vendor is assigned
--        to the transaction via vendor_assignments — the SAME rail
--        requireLenderVendorActor (lib/kernel/portal-auth.ts:70-87) authorizes
--        the lender/vendor portal actions on. vendor_has_transaction_access()
--        was considered and NOT used: it reads vendor_contact_assignments,
--        while the lender rail (lib/kernel/lender-linkage.ts, manager-registry
--        'lender_in_transaction') assigns through vendor_assignments — the
--        existing helper would refuse the measured lane.
--      · has_vendor_seat(): the caller holds ANY vendor seat. Deliberately the
--        coarsest of the three — see the client_portal_messages note in (B).
--    Preconditions: refuse if any of the three names already exists — this
--    migration must not silently replace someone else's function.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('is_own_agent_user_id','is_assigned_vendor_on_transaction','has_vendor_seat')
  ) then
    raise exception 'm482: one of is_own_agent_user_id / is_assigned_vendor_on_transaction / has_vendor_seat already exists — refusing to replace a function this migration did not author';
  end if;
end $$;

create function public.is_own_agent_user_id(p_user_id uuid)
returns boolean
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select p_user_id is not null
     and exists (
       select 1
       from   public.contacts c
       join   public.agents   a on a.id = c.agent_id
       where  c.contact_user_id = auth.uid()
         and  a.user_id = p_user_id
     );
$$;

create function public.is_assigned_vendor_on_transaction(p_transaction_id uuid)
returns boolean
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select p_transaction_id is not null
     and exists (
       select 1
       from   public.vendor_assignments     va
       join   public.user_role_assignments ura on ura.vendor_id = va.vendor_id
       where  ura.user_id = auth.uid()
         and  va.transaction_id = p_transaction_id
     );
$$;

create function public.has_vendor_seat()
returns boolean
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1 from public.user_role_assignments ura
    where ura.user_id = auth.uid() and ura.vendor_id is not null
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- (A) 50 TABLES WHOSE PORTAL LANE RIDES THE SERVICE CLIENT (or that have no
--     portal lane at all). Fresh writer census, per table (file:line = the
--     writer that decided the classification; svc = createServiceClient):
--
--   agent_onboarding        lib/kernel/users.ts:306 svc; app/api/recruiting/provision-agent/route.ts:176 svc
--   agent_quiz_attempts     lib/kernel/agent-onboarding.ts:585 (agent seat, staff surface)
--   ai_assistant_notes      app/api/internal/ai-note/route.ts:187 svc; lib/kernel/reporting.ts:1046 svc
--   ai_message_drafts       app/crm/page.tsx:3028 + dashboard surfaces (staff); lib/orchestrator/internal.ts:671 svc
--   ai_tool_usage           app/actions/ai-tools-hub.ts:131 (staff); lib/kernel/ai-tools.ts:237 svc
--                           NOTE: a SECOND permissive INSERT policy "Users can
--                           insert their own AI usage" WITH CHECK (user_id =
--                           auth.uid()) stays: it is identity-bearing and
--                           user-pinned, not the client-seat blanket this
--                           stratum closes. Its missing tenant pin is a
--                           separate (m460-class) finding, recorded, not fixed
--                           blind here.
--   ai_video_projects       app/content-studio (staff); lib/video/avatar-explainer.ts:479 svc
--   calendar_events         lib/kernel/calendar-engine.ts:28 (staff/cron callers); lib/ai-isa/appointment-scheduler.ts:101 svc
--   calendar_sync_logs      app/actions/ai-calendar-management.ts:671 (staff); lib/kernel/calendar-sync.ts:201
--   cma_reports             app/actions/ai-cma.ts:199 svc; lib/cma/ai-cma-engine.ts:203 svc
--   compliance_events       lib/kernel/compliance-ledger.ts:121 svc; app/actions/ai-voice-transcription.ts:228 (staff)
--   content_ab_tests        app/actions/ai-content-generation.tsx:2504 (staff)
--   content_calendar        app/actions/ai-content-generation.tsx:2326 (staff)
--   content_templates       app/actions/ai-content-generation.tsx:224 (staff)
--   conversations           app/actions/ai-chat.ts:184 (agent coaching, staff-only: identity.agentId required);
--                           app/api/webhooks/meta-dm/route.ts:131 svc
--   direct_mail_campaigns   app/actions/direct-mail.ts:104 (staff); lib/farm-mail/dispatch-farm-mail.ts:292 svc
--   email_campaigns         app/actions/email-campaigns.ts:108 (staff)
--   email_templates         app/actions/email-campaigns.ts:662 (staff)
--   feature_access_overrides app/actions/superadmin/tenant-entitlements.ts:153 svc; dashboard admin (staff)
--   hashtag_performance     app/actions/ai-content-generation.tsx:765 (staff)
--   home_value_estimates    app/actions/home-value.ts:505 — supabase = createServiceClient() (line 209):
--                           the PUBLIC home-value intake rides service, as anon must
--   home_value_page_configs app/actions/home-value.ts:1564 svc
--   lead_deduplication_log  lib/kernel/crm.ts:215 svc; lib/lead-pipeline/pipeline-processor.ts:791 (cron/service callers)
--   listing_agreements      app/actions/seller-listing/execution-engine.ts:695 (staff)
--   listing_media           app/actions/photo-management.ts:544 (staff); lib/orchestrator/internal.ts:701 svc
--   listing_page_analytics  app/actions/listing-landing.ts:448 — createServiceClient() (public listing pages ride service)
--   listing_stage_history   lib/application/listing-lifecycle.ts:445 svc
--   neighborhood_reports    app/actions/neighborhood-reports.ts:337 (staff, createClient)
--   newsletter_campaigns    app/actions/ai-newsletter.ts:850 (staff); lib/marketing/newsletter-cadence.ts:81 svc
--   newsletter_sends        app/api/cron/publish-newsletters/route.ts:418 svc; app/actions/ai-newsletter.ts:1100 (staff)
--   newsletter_teasers      app/actions/podcast-generation.ts:1462 (staff)
--   offer_comparison        lib/kernel/offers.ts:332 (staff workspace)
--   offers                  app/actions/seller-offers.ts:306 svc; lib/inbound-mail/offer-intake.ts:327 svc;
--                           lib/kernel/offers.ts:397 issueCounterOffer (staff CRM / voice-webhook svc).
--                           The buyer/seller PORTAL lanes are reads + service:
--                           app/actions/buyer-offer-tools.ts writes ride svc
--                           (186/252/359/428/478), app/actions/portal-seller.ts
--                           only SELECTs offers (452/532/648). This CONTRADICTS
--                           the census's portal-written call for offers —
--                           recorded in the authoring report.
--   open_house_attendees    app/api/open-house/attend/route.ts:138 svc (public sign-in); lib/kernel/open-house.ts:352 svc
--   open_house_events       app/actions/open-house-automation.ts:74 (staff); lib/wizard-staging/content-staging.ts:192 svc
--   open_house_feedback     app/actions/open-house-automation.ts:1439 — svc (ctor at 1385)
--   open_house_invitations  app/actions/seller-open-house.ts:217 (staff: requireCaller + /dashboard revalidate;
--                           the portal imports only the getOpenHouseDashboard read)
--   podcast_show_settings   app/actions/podcast-generation.ts:1254 (staff)
--   property_interests      app/actions/multi-persona.ts:1107 svc; app/crm search-client.tsx (staff browser)
--   qr_codes                app/actions/marketing-studio.ts:1006 (staff); lib/marketing/tracked-qr.ts:92 svc
--   sequence_enrollments    lib/campaign-sequences/enrollment-engine.ts:110 svc; lib/campaigns/enroll-in-sequence.ts:95 svc
--   showing_feedback_requests app/actions/seller-showings.ts:644 (staff); lib/kernel/showing-lifecycle.ts:64 svc
--   showing_requests        lib/kernel/self-book.ts:163 — svc passed in by app/actions/self-book-showing.ts:83
--                           (the portal self-book lane rides service, by that file's own header);
--                           app/actions/outside-agent-showing.ts:52 svc (public form);
--                           app/actions/seller-open-house.ts:845 (staff)
--   showings                lib/kernel/self-book.ts:173 svc; app/api/showings/feedback/[token]/route.ts:38 svc
--                           (public token lane rides service); app/actions/seller-showings.ts:150 (staff)
--   social_posts            app/actions/social-publishing.ts:344 (staff); lib/social/orchestrate-social-preset-publish.ts:109 svc
--   tasks                   app/actions/tasks.ts:211 (staff); portal-adjacent writers ride svc
--                           (app/actions/multi-persona.ts:411, app/actions/vendor-requests.ts:94)
--   tax_categories          app/actions/accounting-sync.ts:396 (staff)
--   usage_counters          lib/usage.ts:53 — supabase = createServiceClient() (line 25); lib/usage/log-media-usage.ts:93 svc.
--                           The census called this uncertain; the tree moved —
--                           the usage lane now rides service, exactly as the
--                           m478 report said it should.
--   valuation_requests      app/actions/home-value.ts:415 svc (public intake); lib/kernel/lead-magnets.ts:505 svc
--   vendor_assignments      app/actions/vendor-marketplace.ts:1206 assignVendorToTransaction (staff flow —
--                           the vendor portal imports only bookings/reviews); lib/kernel/vendors.ts:659 svc
--   voice_calls             app/actions/voice-call-bridge.ts:99 (staff); lib/voice/twilio-outbound.ts:204 svc
do $$
declare
  v_tables constant text[] := array[
        'agent_onboarding','agent_quiz_attempts','ai_assistant_notes',
        'ai_message_drafts','ai_tool_usage','ai_video_projects',
        'calendar_events','calendar_sync_logs','cma_reports',
        'compliance_events','content_ab_tests','content_calendar',
        'content_templates','conversations','direct_mail_campaigns',
        'email_campaigns','email_templates','feature_access_overrides',
        'hashtag_performance','home_value_estimates','home_value_page_configs',
        'lead_deduplication_log','listing_agreements','listing_media',
        'listing_page_analytics','listing_stage_history','neighborhood_reports',
        'newsletter_campaigns','newsletter_sends','newsletter_teasers',
        'offer_comparison','offers','open_house_attendees',
        'open_house_events','open_house_feedback','open_house_invitations',
        'podcast_show_settings','property_interests','qr_codes',
        'sequence_enrollments','showing_feedback_requests','showing_requests',
        'showings','social_posts','tasks',
        'tax_categories','usage_counters','valuation_requests',
        'vendor_assignments','voice_calls'
  ];
  r record;
  n int := 0;
  v_stray int;
begin
  -- Precondition: on these 50 tables the ONLY INSERT policy besides
  -- <table>_tenant_insert is the known identity-bearing ai_tool_usage
  -- own-user policy. Anything else means a policy landed since this was
  -- measured — stop and re-census rather than tighten beside an unknown door.
  select count(*) into v_stray
  from pg_policies
  where schemaname = 'public'
    and cmd = 'INSERT'
    and tablename = any(v_tables)
    and policyname <> tablename || '_tenant_insert'
    and not (tablename = 'ai_tool_usage' and policyname = 'Users can insert their own AI usage');
  if v_stray <> 0 then
    raise exception 'm482(A): % unexpected extra INSERT policies on the 50 staff/service tables — the ground shifted, refusing', v_stray;
  end if;

  for r in
    select tablename, policyname, with_check
    from pg_policies
    where schemaname = 'public'
      and cmd = 'INSERT'
      and tablename = any(v_tables)
      and policyname = tablename || '_tenant_insert'
  loop
    -- Same per-policy preconditions as m478: a tenant pin must be present and
    -- no identity/role test may already be there.
    if r.with_check is null or r.with_check !~ 'brokerage_id' then
      raise exception 'm482(A): %.% has no brokerage_id pin in with_check — not the measured stratum, refusing', r.tablename, r.policyname;
    end if;
    if r.with_check ~ 'user_type|is_brokerage|is_platform|is_tenant_staff_seat|is_team_lead|auth\.uid|jwt' then
      raise exception 'm482(A): %.% already carries an identity test — refusing to rewrite blind', r.tablename, r.policyname;
    end if;
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
    execute format(
      'create policy %I on public.%I for insert with check ((%s) and public.is_tenant_staff_seat())',
      r.policyname, r.tablename, r.with_check);
    n := n + 1;
  end loop;
  raise notice 'm482(A): tightened % INSERT policies', n;
  -- Exactly one bare-tenant INSERT policy per listed table, verified live
  -- before authoring: 50 tables, 50 policies.
  if n <> 50 then
    raise exception 'm482(A): expected exactly 50 policies across 50 tables, rewrote %', n;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- (B) 5 TABLES A CONSUMER SEAT REALLY WRITES WITH ITS OWN RLS CLIENT.
--     Compound policy: (original tenant pin, verbatim) AND
--     (is_tenant_staff_seat() OR <own-row>), own-row derived per table from the
--     measured writer:
--
--   client_documents
--     writer: app/actions/documents.ts:257 uploadDocument — createClient(),
--     called by the portal upload dialog (app/components/portal/DocumentUploadDialog.tsx:17,96
--     ← app/portal/[contactId]/documents/DocumentsClient.tsx). The row carries
--     uploaded_by = auth user (documents.ts:266) and contact_id = the portal's
--     own contact. Lender/vendor doc lanes ride svc
--     (app/actions/journey-tasks.ts:135, app/actions/vendor-w9.ts:107,
--      app/actions/buyer-financial.ts:128).
--     own-row: uploaded_by = auth.uid() OR is_self_contact(contact_id).
--
--   client_portal_messages
--     writers with the caller's client: app/actions/journey-tasks.ts:474,502
--     (contact session via orchestrator fanout, contact_id = self);
--     app/actions/lender-portal-actions.ts:221,278 (lender vendor seat);
--     app/actions/vendor-portal.ts:572 (vendor seat, transaction-linked);
--     app/actions/title-portal.ts:532 (title seat — user_type 'title_agent' is
--     a staff seat under m475). The main portal send lane rides svc on purpose
--     (app/actions/portal-messages.ts:149-153, with its own worked rationale).
--     own-row: is_self_contact(contact_id) OR has_vendor_seat().
--     has_vendor_seat() is deliberately the COARSE lane: two live lender writes
--     carry no row-level anchor to narrow on — lender-portal-actions.ts:221
--     inserts the buyer CTC message WITHOUT transaction_id, and :278 stuffs an
--     agents.id into contact_id — so the vendor lane pins to "a vendor seat in
--     the pinned tenant" (the tenant pin still applies) and the row-level
--     narrowing waits on the app fixes recorded in the authoring report. The
--     CONTACT-seat gap — any client writing any other client's thread — is
--     closed either way, which is what this stratum is for.
--
--   notifications
--     writers with the caller's client: app/portal/[contactId]/layout.tsx:201
--     (contact lights own agent's bell, user_id = own agent's users.id);
--     app/actions/journey-tasks.ts:443 (same pair via
--     resolveAgentRecordToUserId). Portal/widget bell lanes otherwise ride svc
--     (app/api/widget/intake/route.ts:281, app/api/widget/live-agent-request/route.ts:107,
--      app/api/portal/escalate/route.ts:37, app/api/portal/ai-chat/route.ts:389,
--      app/actions/portal-lifetime.ts:114..428, app/actions/buyer-offer-tools.ts svc).
--     own-row: is_self_contact(contact_id) OR is_own_agent_user_id(user_id) —
--     a contact may light their own bell or their own agent's, nobody else's.
--
--   portal_access_logs
--     writer: lib/kernel/portal.ts:420 logPortalAccess — createClient() under
--     the portal visitor's own session, contact_id = the contact being viewed
--     (their own portal). Staff/cron lane rides svc (app/actions/workflows.ts:385).
--     own-row: is_self_contact(contact_id).
--
--   transaction_milestones
--     writer: app/actions/lender-portal-actions.ts:203 issueClearToClose —
--     createClient() under the lender vendor's seat, insert carries
--     transaction_id; the caller was authorized by requireLenderVendorActor
--     against the vendor_assignments rail (lib/kernel/portal-auth.ts:70-87).
--     Staff lanes: app/actions/ai-contract-review.ts:638,
--     lib/transactions/milestone-service.ts:84 svc.
--     own-row: is_assigned_vendor_on_transaction(transaction_id).
do $$
declare
  v_own constant text[][] := array[
    ['client_documents',       '(uploaded_by = auth.uid()) or (contact_id is not null and public.is_self_contact(contact_id))'],
    ['client_portal_messages', '(contact_id is not null and public.is_self_contact(contact_id)) or public.has_vendor_seat()'],
    ['notifications',          '(contact_id is not null and public.is_self_contact(contact_id)) or (user_id is not null and public.is_own_agent_user_id(user_id))'],
    ['portal_access_logs',     '(contact_id is not null and public.is_self_contact(contact_id))'],
    ['transaction_milestones', '(transaction_id is not null and public.is_assigned_vendor_on_transaction(transaction_id))']
  ];
  i int;
  r record;
  n int := 0;
begin
  for i in 1 .. array_length(v_own, 1) loop
    select tablename, policyname, with_check into r
    from pg_policies
    where schemaname = 'public'
      and cmd = 'INSERT'
      and tablename = v_own[i][1]
      and policyname = v_own[i][1] || '_tenant_insert';
    if r.tablename is null then
      raise exception 'm482(B): %_tenant_insert not found — the ground shifted, refusing', v_own[i][1];
    end if;
    -- Same preconditions as (A): bare tenant pin, no identity test yet.
    if r.with_check is null or r.with_check !~ 'brokerage_id' then
      raise exception 'm482(B): %.% has no brokerage_id pin — refusing', r.tablename, r.policyname;
    end if;
    if r.with_check ~ 'user_type|is_brokerage|is_platform|is_tenant_staff_seat|is_team_lead|auth\.uid|jwt' then
      raise exception 'm482(B): %.% already carries an identity test — refusing to rewrite blind', r.tablename, r.policyname;
    end if;
    -- These five must have exactly ONE INSERT policy, or the compound claim is
    -- false the way the (C) pair's was.
    if (select count(*) from pg_policies
        where schemaname = 'public' and cmd = 'INSERT' and tablename = r.tablename) <> 1 then
      raise exception 'm482(B): % carries more than one INSERT policy — refusing', r.tablename;
    end if;
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
    execute format(
      'create policy %I on public.%I for insert with check ((%s) and (public.is_tenant_staff_seat() or %s))',
      r.policyname, r.tablename, r.with_check, v_own[i][2]);
    n := n + 1;
  end loop;
  raise notice 'm482(B): rewrote % policies as compound (staff-seat OR own-row)', n;
  if n <> 5 then
    raise exception 'm482(B): expected exactly 5 compound rewrites, did %', n;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- (C) THE DOUBLE-POLICY PAIR. Each carried a second permissive INSERT policy
--     WITH CHECK (true), which made any tightening of the tenant policy alone
--     a false claim (m478 skipped both for exactly that reason). Both second
--     policies are DEAD, measured against the current tree:
--
--   chat_sessions."widget_insert_chat_sessions"  (roles {authenticated}, true)
--     The widget lane it was named for writes through the SERVICE client on
--     every route: app/api/widget/session/route.ts:95, .../capture/route.ts:136,
--     .../intake/route.ts:207 (all createServiceClient), as do the portal and
--     internal chat lanes (app/api/portal/ai-chat/route.ts:119,
--     app/api/internal/ai-chat/route.ts:452) and the agent-guide seeder
--     (lib/education/agent-guide.ts:106). The service role never consults RLS,
--     no anon lane exists (the policy is authenticated-only), and no
--     RLS-client writer of chat_sessions remains anywhere in app/, lib/,
--     components/, services/. Post-#187 the widget rides tokens + service —
--     the permissive policy guards nothing and admits every seat. DROPPED.
--
--   vendor_usage_tracking."Service role can insert vendor usage"
--     (roles {authenticated}, true) — misnamed twice over: the service role
--     bypasses RLS entirely (a policy for it is a no-op), and what the policy
--     actually did was let ANY authenticated seat insert untenanted usage
--     rows. The only RLS-client writer is lib/vendor-tracking.ts:19
--     (createClient), called solely from app/actions/scrape-social-media.ts
--     (staff surface) with the caller's own brokerage_id — it rides the tenant
--     policy. The governance lane rides svc
--     (lib/vendor-governance/usage-logger.ts:79). DROPPED.
--
--     Both tenant policies are then tightened exactly like (A).
do $$
declare
  r record;
  n_drop int := 0;
  n_tight int := 0;
begin
  -- Drop the dead permissive policies — but only if they still look exactly
  -- like what was measured (WITH CHECK (true)); anything else means someone
  -- rewrote them since and this migration must not assume.
  for r in
    select tablename, policyname, with_check
    from pg_policies
    where schemaname = 'public'
      and cmd = 'INSERT'
      and ((tablename = 'chat_sessions'          and policyname = 'widget_insert_chat_sessions')
        or (tablename = 'vendor_usage_tracking'  and policyname = 'Service role can insert vendor usage'))
  loop
    if r.with_check is distinct from 'true' then
      raise exception 'm482(C): %.% is no longer WITH CHECK (true) — refusing to drop a policy that changed since the census', r.tablename, r.policyname;
    end if;
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
    n_drop := n_drop + 1;
  end loop;
  if n_drop <> 2 then
    raise exception 'm482(C): expected to drop exactly 2 dead permissive policies, dropped %', n_drop;
  end if;

  for r in
    select tablename, policyname, with_check
    from pg_policies
    where schemaname = 'public'
      and cmd = 'INSERT'
      and tablename in ('chat_sessions','vendor_usage_tracking')
  loop
    if r.policyname <> r.tablename || '_tenant_insert' then
      raise exception 'm482(C): unexpected surviving INSERT policy %.% — refusing', r.tablename, r.policyname;
    end if;
    if r.with_check is null or r.with_check !~ 'brokerage_id' then
      raise exception 'm482(C): %.% has no brokerage_id pin — refusing', r.tablename, r.policyname;
    end if;
    if r.with_check ~ 'user_type|is_brokerage|is_platform|is_tenant_staff_seat|is_team_lead|auth\.uid|jwt' then
      raise exception 'm482(C): %.% already carries an identity test — refusing', r.tablename, r.policyname;
    end if;
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
    execute format(
      'create policy %I on public.%I for insert with check ((%s) and public.is_tenant_staff_seat())',
      r.policyname, r.tablename, r.with_check);
    n_tight := n_tight + 1;
  end loop;
  if n_tight <> 2 then
    raise exception 'm482(C): expected exactly 2 tenant-policy tightenings, did %', n_tight;
  end if;
  raise notice 'm482(C): dropped 2 dead permissive policies, tightened 2 tenant policies';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- POSTCONDITIONS. Stated literally, then verified:
--   * All 57 rewritten <table>_tenant_insert policies (50 A + 5 B + 2 C) carry
--     is_tenant_staff_seat().
--   * Each of the 5 (B) policies carries its own-row predicate.
--   * No INSERT policy WITH CHECK (true) survives on chat_sessions or
--     vendor_usage_tracking, and each now has exactly one INSERT policy.
do $$
declare
  v_all constant text[] := array[
        'agent_onboarding','agent_quiz_attempts','ai_assistant_notes',
        'ai_message_drafts','ai_tool_usage','ai_video_projects',
        'calendar_events','calendar_sync_logs','cma_reports',
        'compliance_events','content_ab_tests','content_calendar',
        'content_templates','conversations','direct_mail_campaigns',
        'email_campaigns','email_templates','feature_access_overrides',
        'hashtag_performance','home_value_estimates','home_value_page_configs',
        'lead_deduplication_log','listing_agreements','listing_media',
        'listing_page_analytics','listing_stage_history','neighborhood_reports',
        'newsletter_campaigns','newsletter_sends','newsletter_teasers',
        'offer_comparison','offers','open_house_attendees',
        'open_house_events','open_house_feedback','open_house_invitations',
        'podcast_show_settings','property_interests','qr_codes',
        'sequence_enrollments','showing_feedback_requests','showing_requests',
        'showings','social_posts','tasks',
        'tax_categories','usage_counters','valuation_requests',
        'vendor_assignments','voice_calls',
        'client_documents','client_portal_messages','notifications',
        'portal_access_logs','transaction_milestones',
        'chat_sessions','vendor_usage_tracking'
  ];
  v_bad int;
begin
  select count(*) into v_bad
  from pg_policies
  where schemaname = 'public'
    and cmd = 'INSERT'
    and tablename = any(v_all)
    and policyname = tablename || '_tenant_insert'
    and coalesce(with_check, qual) !~ 'is_tenant_staff_seat';
  if v_bad <> 0 then
    raise exception 'm482: % tenant INSERT policies remain without the seat test', v_bad;
  end if;

  select 5 - count(*) into v_bad
  from pg_policies
  where schemaname = 'public' and cmd = 'INSERT'
    and (   (tablename = 'client_documents'       and with_check ~ 'uploaded_by' and with_check ~ 'is_self_contact')
         or (tablename = 'client_portal_messages' and with_check ~ 'is_self_contact' and with_check ~ 'has_vendor_seat')
         or (tablename = 'notifications'          and with_check ~ 'is_self_contact' and with_check ~ 'is_own_agent_user_id')
         or (tablename = 'portal_access_logs'     and with_check ~ 'is_self_contact')
         or (tablename = 'transaction_milestones' and with_check ~ 'is_assigned_vendor_on_transaction'));
  if v_bad <> 0 then
    raise exception 'm482: % of the 5 compound policies are missing their own-row predicate', v_bad;
  end if;

  select count(*) into v_bad
  from pg_policies
  where schemaname = 'public' and cmd = 'INSERT'
    and tablename in ('chat_sessions','vendor_usage_tracking')
    and with_check = 'true';
  if v_bad <> 0 then
    raise exception 'm482: % WITH CHECK (true) INSERT policies survive on the (C) pair', v_bad;
  end if;

  if (select count(*) from pg_policies
      where schemaname = 'public' and cmd = 'INSERT'
        and tablename in ('chat_sessions','vendor_usage_tracking')) <> 2 then
    raise exception 'm482: the (C) pair should end with exactly one INSERT policy each';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- (D) LEFT UNTOUCHED, ON PURPOSE — no defensible own-row test exists for a
--     live consumer-session writer. Each entry names the missing evidence /
--     blocking app write; none of these is fixed here because app-side changes
--     are out of this migration's scope.
--
--   activities
--     The portal document flows write it with the CONTACT's OWN RLS client and
--     rows that carry NO caller-linkable column: app/actions/documents.ts:164
--     (analyzeDocument — no contact_id, agent_id stuffed with a brokerage_id)
--     and :1129 (askDocumentQuestion — no contact_id), both reachable from
--     app/portal/[contactId]/documents/DocumentsClient.tsx; :288
--     (uploadDocument) does set contact_id. An is_self_contact(contact_id)
--     own-row would silently refuse the analyze/ask audit rows. It ALSO
--     carries a second permissive INSERT policy (activities_insert_own,
--     tenant-free agent own-row), so a tenant-policy tightening alone would be
--     a false claim — the (C) argument. BLOCKED ON: moving the three
--     documents.ts activity writes to the service client (they are post-authz
--     audit writes) and revisiting activities_insert_own's missing tenant pin.
--
--   automation_errors, error_stack_traces, error_resolution_log
--     Written by lib/errors/collect-error.ts:96,119,139 and
--     lib/errors/auto-retry.ts with the REQUEST's RLS client;
--     app/api/errors/collect/route.ts accepts ANY authenticated seat
--     (contact/lender/vendor included) as the error-intake surface. No
--     identity column exists to pin an own-row on, and staff-gating would
--     silently drop consumer-session error reports. BLOCKED ON: collect-error
--     riding the service client after the route's own auth check.
--
--   message_provider_logs
--     lib/services/communication.service.tsx:104 (and its SMS/invite
--     siblings at 134,170) write the provider audit row with the caller's RLS
--     client, and the service is reachable from consumer sessions
--     (app/actions/calculators.ts:1612 sendCalculatorResults;
--     app/actions/collaborative-search.ts:221 sendCollaborativeSearchInvite).
--     The table carries no contact/user column at all, so no own-row is
--     stateable. This CONTRADICTS the census note that the provider-log lane
--     had moved to service — the spine's persister did
--     (lib/communication-spine/message-persister.ts, svc), communication.service
--     did not. BLOCKED ON: those audit writes riding the service client.
--
--   (already-guarded, from the 71-policy stratum, untouched:
--    closing_disclosure_agreement, collaborative_search_members,
--    collaborative_search_properties, open_house_analytics, property_consensus,
--    subscriber_service_areas, support_ticket_messages, support_tickets,
--    transactions — see header.)
