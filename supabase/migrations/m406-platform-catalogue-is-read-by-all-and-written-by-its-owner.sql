-- m406 — the shared platform catalogue is READ by every tenant and WRITTEN only
--        by its owner (the tenant that owns the row) or a platform admin.
--
-- THE DEFECT, MEASURED LIVE, NOT REASONED ABOUT
--
-- Running as an ordinary `agent` (users.user_type='agent', one brokerage), RLS
-- on, inside a transaction that was rolled back:
--
--     table                       platform rows   UPDATE reached   DELETE reached
--     onboarding_steps                       66               66               66
--     training_videos                        12               12               12
--     help_topics_kb                         11               11               11
--     service_status                         13               13               13
--     thank_you_note_templates                4                4                4
--     api_response_logs                       3                3                3
--
-- Every row in each of those tables is a PLATFORM row (brokerage_id IS NULL) —
-- 100% of them. So any single agent at any brokerage could rewrite or delete the
-- platform's shared onboarding checklist, training library, help knowledge base
-- and service-status catalogue for EVERY OTHER TENANT. The `brokerage_id IS NULL`
-- disjunct on the WRITE side of the migration-029 tenant policy
-- (`USING (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())`,
-- installed identically for FOR ALL) is what permitted it. 029's own header calls
-- that branch a grandfather clause for rows believed not to exist; it is not one,
-- it is a standing rule that a row with no tenant belongs to everyone — including
-- for writing.
--
-- WHY THE FIX IS NOT "REMOVE THE ESCAPE"
--
-- The naive reading of #156 — strip `brokerage_id IS NULL` everywhere — is the
-- one change that must NOT be made here. Because every row in these tables is a
-- platform row, stripping the branch from SELECT would return ZERO onboarding
-- steps, ZERO training videos and ZERO help articles to every tenant at once. It
-- would not scope the feature, it would empty it. The owner's ruling is exactly
-- that correction:
--
--   "tenant only sees their own unless it is of course, training or knowledge
--    base and support tickets for the platform. raw leads are only platform
--    viewable ..."
--
-- So READ and WRITE split, per table:
--
--   SELECT  keeps `brokerage_id IS NULL OR brokerage_id = <caller's tenant>`.
--           That IS "a tenant sees its own plus the platform's".
--   INSERT
--   UPDATE  the NULL branch becomes `is_platform_admin()`. A tenant may write
--   DELETE  only rows carrying its OWN brokerage_id.
--
-- is_platform_admin() is the repo's existing helper (SECURITY DEFINER:
-- platform_role='superadmin' OR user_type IN ('superadmin','super_admin')). No new
-- helper is invented here.
--
-- WHAT ELSE THIS FILE CARRIES, AND WHY IT IS THE SAME CHANGE
--
--  * content_topic_sources had ONE policy, FOR SELECT. Its INSERT/UPDATE/DELETE
--    were therefore default-DENIED, and app/actions/content-intel/sources.ts
--    drives all three through the RLS-bound session client. Probed live as the
--    same agent: inserting the tenant's OWN row is REFUSED ("new row violates
--    row-level security policy"). Creating, toggling and deleting a content
--    source has never worked. The three policies added below are the same
--    owner-or-platform-admin shape as everywhere else in this file, so the table
--    lands correct and the feature starts working in one move rather than being
--    left denied on a technicality.
--
--  * training_videos' three role-gated write policies carried NO tenant predicate
--    at all — `user_type IN ('admin','broker','superadmin')` and nothing else — so
--    a broker at brokerage A could edit brokerage B's videos, and the UPDATE
--    policy had no WITH CHECK, so it could also MOVE a row to another brokerage.
--    The role test is preserved verbatim (deliberately NOT swapped for
--    is_brokerage_admin(), whose roster contains broker_owner and would WIDEN);
--    the tenant predicate is ANDed onto it and an explicit WITH CHECK added.
--    They were also granted to PUBLIC; narrowed to `authenticated`, which removes
--    nothing real (anon has no auth.uid(), so the EXISTS was already false).
--
--  * buyer_stage_coaching carried TWO SELECT policies meaning the same thing.
--    Consolidated below — see the note on that statement.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH
--
--  * raw_scraped_leads. Already platform-only, verified rather than assumed: all
--    four policies read `is_platform_admin() OR (is_ai_isa_system() AND ...)`,
--    and probed live the ordinary agent SELECTs 0 rows and is REFUSED on INSERT
--    for both a NULL and its own brokerage_id. Nothing to fix, and the scraping
--    pipeline is on hold.
--  * knowledge_articles. Already correct: knowledge_articles_admin is
--    `is_platform_admin() OR (is_brokerage_admin() AND has_brokerage_access(brokerage_id))`
--    and has_brokerage_access() requires its argument to be NOT NULL, so a
--    brokerage admin already cannot write a platform row. Its SELECT policy keeps
--    the NULL branch, which is what the ruling requires.

-- ─────────────────────────────────────────────────────────────────────────────
-- onboarding_steps — SELECT untouched, writes gated.
-- ─────────────────────────────────────────────────────────────────────────────
alter policy onboarding_steps_tenant_insert on public.onboarding_steps
  with check (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id());
alter policy onboarding_steps_tenant_update on public.onboarding_steps
  using       (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id())
  with check  (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id());
alter policy onboarding_steps_tenant_delete on public.onboarding_steps
  using       (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- service_status — SELECT untouched, writes gated.
-- ─────────────────────────────────────────────────────────────────────────────
alter policy service_status_tenant_insert on public.service_status
  with check (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id());
alter policy service_status_tenant_update on public.service_status
  using       (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id())
  with check  (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id());
alter policy service_status_tenant_delete on public.service_status
  using       (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- support_tickets — "support tickets for the platform": the tenant sees and files
-- its OWN tickets, a platform admin sees ALL of them. This is the one table in
-- the file whose SELECT also loses the NULL branch, because a support ticket is
-- not shared catalogue content — an untenanted ticket is not everyone's ticket.
-- The platform-side console (app/actions/superadmin/support-console.ts) already
-- reads every tenant's tickets, but it does so on the SERVICE client, which
-- bypasses RLS entirely; is_platform_admin() gives that same reach a policy-level
-- basis instead of leaving it dependent on a key that ignores policies.
-- ─────────────────────────────────────────────────────────────────────────────
alter policy support_tickets_tenant_select on public.support_tickets
  using       (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id());
alter policy support_tickets_tenant_insert on public.support_tickets
  with check  (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id());
alter policy support_tickets_tenant_update on public.support_tickets
  using       (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id())
  with check  (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id());
alter policy support_tickets_tenant_delete on public.support_tickets
  using       (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- api_response_logs — platform telemetry. Its ONLY writer is the connector
-- gateway (lib/agentic-os/connector-gateway.ts:132), on the service client, and
-- it writes brokerage_id: null on every row on purpose ("gateway calls are
-- provider-scoped"). Its only reader (app/actions/system-health.ts:399) filters
-- `.eq("brokerage_id", ctx.brokerageId)`, which can never match a NULL row — so
-- the tenant read of the platform rows was already dead code, and closing it
-- changes no observable behaviour while removing a write path that reached 3 of
-- 3 live rows. SELECT keeps the tenant's OWN rows for the same reason the rest of
-- this file does: "tenant only sees their own".
-- ─────────────────────────────────────────────────────────────────────────────
alter policy api_response_logs_tenant_select on public.api_response_logs
  using       (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id());
alter policy api_response_logs_tenant_insert on public.api_response_logs
  with check  (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id());
alter policy api_response_logs_tenant_update on public.api_response_logs
  using       (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id())
  with check  (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id());
alter policy api_response_logs_tenant_delete on public.api_response_logs
  using       (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- help_topics_kb — the FOR ALL policy is the write vector and cannot be ALTERed
-- into a read-only one, so it is replaced by a SELECT policy carrying the SAME
-- USING expression plus three gated write policies.
--
-- The replacement SELECT deliberately does NOT filter on is_active. The other
-- surviving policy (help_topics_kb_select) does, and permissive policies OR
-- together — so today the effective read admits inactive rows, which is what the
-- knowledge-base admin surface needs in order to show a drafted/retired article
-- at all. Re-adding the filter here would have been a silent read regression
-- smuggled in under a write fix.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists help_topics_kb_access on public.help_topics_kb;

create policy help_topics_kb_read on public.help_topics_kb
  for select to authenticated
  using (brokerage_id is null or brokerage_id = public.current_user_brokerage_id());

create policy help_topics_kb_owner_insert on public.help_topics_kb
  for insert to authenticated
  with check (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id());

create policy help_topics_kb_owner_update on public.help_topics_kb
  for update to authenticated
  using      (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id())
  with check (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id());

create policy help_topics_kb_owner_delete on public.help_topics_kb
  for delete to authenticated
  using (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- training_videos — same FOR ALL replacement, plus the three role-gated write
-- policies gain the tenant predicate they never had.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists training_videos_access on public.training_videos;

create policy training_videos_read on public.training_videos
  for select to authenticated
  using (brokerage_id is null or brokerage_id = public.current_user_brokerage_id());

alter policy training_videos_insert on public.training_videos
  to authenticated
  with check (
    public.is_platform_admin()
    or (exists (select 1 from public.users
                 where users.id = auth.uid()
                   and users.user_type = any (array['admin'::text,'broker'::text,'superadmin'::text]))
        and brokerage_id = public.current_user_brokerage_id())
  );

alter policy training_videos_update on public.training_videos
  to authenticated
  using (
    public.is_platform_admin()
    or (exists (select 1 from public.users
                 where users.id = auth.uid()
                   and users.user_type = any (array['admin'::text,'broker'::text,'superadmin'::text]))
        and brokerage_id = public.current_user_brokerage_id())
  )
  with check (
    public.is_platform_admin()
    or (exists (select 1 from public.users
                 where users.id = auth.uid()
                   and users.user_type = any (array['admin'::text,'broker'::text,'superadmin'::text]))
        and brokerage_id = public.current_user_brokerage_id())
  );

alter policy training_videos_delete on public.training_videos
  to authenticated
  using (
    public.is_platform_admin()
    or (exists (select 1 from public.users
                 where users.id = auth.uid()
                   and users.user_type = any (array['admin'::text,'broker'::text,'superadmin'::text]))
        and brokerage_id = public.current_user_brokerage_id())
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- thank_you_note_templates — the FOR ALL policy resolves the tenant through
-- `agents`, not `users`. That is preserved EXACTLY on both sides rather than
-- normalised to current_user_brokerage_id(): swapping it would widen the read to
-- every authenticated non-agent user, which is not what this wave was asked to
-- decide.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists tyn_templates_brokerage on public.thank_you_note_templates;

create policy tyn_templates_read on public.thank_you_note_templates
  for select to authenticated
  using (
    brokerage_id is null
    or brokerage_id = (select agents.brokerage_id from public.agents
                        where agents.user_id = auth.uid() limit 1)
  );

create policy tyn_templates_owner_insert on public.thank_you_note_templates
  for insert to authenticated
  with check (
    public.is_platform_admin()
    or brokerage_id = (select agents.brokerage_id from public.agents
                        where agents.user_id = auth.uid() limit 1)
  );

create policy tyn_templates_owner_update on public.thank_you_note_templates
  for update to authenticated
  using (
    public.is_platform_admin()
    or brokerage_id = (select agents.brokerage_id from public.agents
                        where agents.user_id = auth.uid() limit 1)
  )
  with check (
    public.is_platform_admin()
    or brokerage_id = (select agents.brokerage_id from public.agents
                        where agents.user_id = auth.uid() limit 1)
  );

create policy tyn_templates_owner_delete on public.thank_you_note_templates
  for delete to authenticated
  using (
    public.is_platform_admin()
    or brokerage_id = (select agents.brokerage_id from public.agents
                        where agents.user_id = auth.uid() limit 1)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- content_topic_sources — SELECT untouched. The three writes below did not exist
-- at all, which is why the feature that drives them has never worked (see header).
-- ─────────────────────────────────────────────────────────────────────────────
create policy content_topic_sources_owner_insert on public.content_topic_sources
  for insert to authenticated
  with check (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id());

create policy content_topic_sources_owner_update on public.content_topic_sources
  for update to authenticated
  using      (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id())
  with check (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id());

create policy content_topic_sources_owner_delete on public.content_topic_sources
  for delete to authenticated
  using (public.is_platform_admin() or brokerage_id = public.current_user_brokerage_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- buyer_stage_coaching — CONSOLIDATE THE DUPLICATE SELECT PAIR.
--
-- Two permissive SELECT policies said the same thing:
--   "Brokers see own and system defaults"
--     brokerage_id IS NULL OR brokerage_id IN (SELECT users.brokerage_id
--                                              FROM users WHERE users.id = auth.uid())
--   bsc_read_brokerage
--     brokerage_id = current_user_brokerage_id() OR brokerage_id IS NULL
--
-- Permissive policies OR together, so the pair is redundant. Proven equivalent
-- before deleting either, not assumed:
--   * current_user_brokerage_id() is `SELECT brokerage_id FROM users WHERE
--     id = auth.uid() LIMIT 1`, and users.id is the primary key, so the IN-list
--     can never hold more than one value and IN degenerates to =.
--   * multi-brokerage users were measured, not hypothesised: 0 users hold
--     user_role_assignments across more than one brokerage (7 assignments, 23
--     users), so there is no second brokerage for the IN-list to admit.
--   * evaluated live as the probe agent, both expressions returned the same
--     brokerage_id (IS NOT DISTINCT FROM = true).
--
-- The survivor is bsc_read_brokerage, and the reason is the one difference that
-- is NOT cosmetic: current_user_brokerage_id() is SECURITY DEFINER and reads
-- `users` with RLS bypassed, while the inline subquery is subject to users' own
-- RLS and would silently resolve to NOTHING — hiding the caller's own brokerage
-- rows — if that self-read policy were ever tightened. The survivor therefore
-- covers every case the dropped policy admitted, and one it does not.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists "Brokers see own and system defaults" on public.buyer_stage_coaching;
