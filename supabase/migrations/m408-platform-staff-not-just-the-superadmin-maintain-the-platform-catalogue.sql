-- m408 — THE PLATFORM CATALOGUE IS MAINTAINED BY PLATFORM STAFF, NOT ONLY BY THE
--        ONE SUPERADMIN. A new helper, `is_platform_staff()`, and NOTHING done to
--        `is_platform_admin()`.
--
-- THE OWNER'S RULING
--
--   "the platform roles are the staff including superadmin, admin, support,
--    marketing."
--
-- Four roles. `users.platform_role`'s CHECK constraint already matches that
-- roster exactly (superadmin, admin, marketing, support, plus the non-human
-- ai_isa_system marker), so this migration adds no vocabulary — it teaches RLS
-- the roster the column has held all along.
--
-- WHY A NEW HELPER AND NOT A WIDER `is_platform_admin()`
--
-- Measured, not assumed: `is_platform_admin()` is named in
--
--     522 policies across 179 tables
--
-- in schema `public`, counted from pg_policy over both polqual and polwithcheck.
-- That set includes commissions, agent_commission_plans, invoices, payouts and
-- every table carrying tenant PII. Editing that one function to admit the four
-- roles would not "apply the ruling" — it would hand a `marketing` account
-- superadmin-equivalent DELETE on the whole schema in a single ALTER. The ruling
-- says who the STAFF are. It does not say a marketing user may delete a
-- commission row. So `is_platform_admin()` is left byte-for-byte alone, and this
-- file introduces a SECOND, NARROWER-USED helper that is applied only where the
-- ruling actually reaches: the shared platform CATALOGUE that m406 had just
-- locked down to the superadmin alone.
--
-- WHAT m406 LEFT BEHIND
--
-- m406 correctly closed a real hole (any single agent could rewrite or delete
-- 100% of the platform's onboarding steps, training videos and help articles for
-- every other tenant) by turning the `brokerage_id IS NULL` write branch into
-- `is_platform_admin()`. Correct, but it swung the door to ONE person. On this
-- database that is literally one account. A support operator cannot fix a typo in
-- a help article; a marketing staffer cannot publish a training video. This file
-- restores that ability to the roster the owner named — and to nobody else.
--
-- THE HELPER MIRRORS is_platform_admin()'s SHAPE ON PURPOSE
--
-- Same SECURITY DEFINER (so it reads `users` without tripping users' own RLS and
-- without recursing into a policy that calls it), same STABLE volatility (so the
-- planner may cache it per statement instead of re-querying per row across a
-- 66-row catalogue scan), same COALESCE(..., FALSE) so an unauthenticated caller
-- — auth.uid() IS NULL, subquery empty — is FALSE rather than NULL, and same
-- legacy `user_type IN ('superadmin','super_admin')` marker so an account that
-- predates the platform_role column is not silently demoted by this change.
--
-- `ai_isa_system` is deliberately ABSENT. It is a value of platform_role, but it
-- marks the two automated ISA service accounts, not a person on the staff. It has
-- its own helper (is_ai_isa_system()) and its own policies on raw_scraped_leads.
--
-- search_path is pinned. is_platform_admin() does not pin one; that is a
-- pre-existing weakness this file declines to reproduce in new code, and pinning
-- it changes no semantics here because every object reference below is already
-- schema-qualified.

create or replace function public.is_platform_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select platform_role in ('superadmin', 'admin', 'marketing', 'support')
         or user_type      in ('superadmin', 'super_admin')
     from public.users where id = auth.uid() limit 1),
    false
  );
$$;

comment on function public.is_platform_staff() is
  'TRUE for the four platform-staff roles the owner named (superadmin, admin, marketing, support) read from users.platform_role, plus the legacy users.user_type superadmin marker. Deliberately NOT the same function as is_platform_admin(), which stays superadmin-only because 522 policies across 179 tables — commissions, invoices, PII — depend on it meaning exactly that. Use is_platform_staff() for the shared platform CATALOGUE; use is_platform_admin() for anything financial, destructive or cross-tenant.';

revoke all on function public.is_platform_staff() from public;
grant execute on function public.is_platform_staff() to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- THE WRITE-SIDE SWAP. SELECT IS NOT TOUCHED ON ANY CATALOGUE TABLE.
--
-- Each statement below replaces `is_platform_admin()` with `is_platform_staff()`
-- in the platform-row branch ONLY. The tenant branch
-- (`brokerage_id = current_user_brokerage_id()`, or the `agents`-resolved variant
-- on thank_you_note_templates) is reproduced verbatim, because it is what lets an
-- ordinary brokerage keep writing its OWN rows and it is not what this wave is
-- ruling on. The swap is a STRICT WIDENING of the platform branch — every caller
-- is_platform_admin() admitted (platform_role='superadmin' OR user_type IN
-- ('superadmin','super_admin')) is admitted by is_platform_staff() too, since
-- 'superadmin' is the first entry of the roster and the legacy user_type marker is
-- carried over unchanged. Nobody loses access here.
-- ─────────────────────────────────────────────────────────────────────────────

-- onboarding_steps — the platform's shared onboarding checklist (66/66 rows are
-- platform rows). Maintaining it is exactly "platform staff maintain the
-- catalogue".
alter policy onboarding_steps_tenant_insert on public.onboarding_steps
  with check (public.is_platform_staff() or brokerage_id = public.current_user_brokerage_id());
alter policy onboarding_steps_tenant_update on public.onboarding_steps
  using      (public.is_platform_staff() or brokerage_id = public.current_user_brokerage_id())
  with check (public.is_platform_staff() or brokerage_id = public.current_user_brokerage_id());
alter policy onboarding_steps_tenant_delete on public.onboarding_steps
  using      (public.is_platform_staff() or brokerage_id = public.current_user_brokerage_id());

-- help_topics_kb — the help knowledge base (11/11 platform rows).
alter policy help_topics_kb_owner_insert on public.help_topics_kb
  with check (public.is_platform_staff() or brokerage_id = public.current_user_brokerage_id());
alter policy help_topics_kb_owner_update on public.help_topics_kb
  using      (public.is_platform_staff() or brokerage_id = public.current_user_brokerage_id())
  with check (public.is_platform_staff() or brokerage_id = public.current_user_brokerage_id());
alter policy help_topics_kb_owner_delete on public.help_topics_kb
  using      (public.is_platform_staff() or brokerage_id = public.current_user_brokerage_id());

-- content_topic_sources — the content-intelligence source catalogue.
alter policy content_topic_sources_owner_insert on public.content_topic_sources
  with check (public.is_platform_staff() or brokerage_id = public.current_user_brokerage_id());
alter policy content_topic_sources_owner_update on public.content_topic_sources
  using      (public.is_platform_staff() or brokerage_id = public.current_user_brokerage_id())
  with check (public.is_platform_staff() or brokerage_id = public.current_user_brokerage_id());
alter policy content_topic_sources_owner_delete on public.content_topic_sources
  using      (public.is_platform_staff() or brokerage_id = public.current_user_brokerage_id());

-- training_videos — the tenant branch here is m406's role-gated EXISTS, preserved
-- verbatim (user_type IN ('admin','broker','superadmin') AND own brokerage). Only
-- the leading platform disjunct moves.
alter policy training_videos_insert on public.training_videos
  with check (
    public.is_platform_staff()
    or (exists (select 1 from public.users
                 where users.id = auth.uid()
                   and users.user_type = any (array['admin'::text,'broker'::text,'superadmin'::text]))
        and brokerage_id = public.current_user_brokerage_id())
  );
alter policy training_videos_update on public.training_videos
  using (
    public.is_platform_staff()
    or (exists (select 1 from public.users
                 where users.id = auth.uid()
                   and users.user_type = any (array['admin'::text,'broker'::text,'superadmin'::text]))
        and brokerage_id = public.current_user_brokerage_id())
  )
  with check (
    public.is_platform_staff()
    or (exists (select 1 from public.users
                 where users.id = auth.uid()
                   and users.user_type = any (array['admin'::text,'broker'::text,'superadmin'::text]))
        and brokerage_id = public.current_user_brokerage_id())
  );
alter policy training_videos_delete on public.training_videos
  using (
    public.is_platform_staff()
    or (exists (select 1 from public.users
                 where users.id = auth.uid()
                   and users.user_type = any (array['admin'::text,'broker'::text,'superadmin'::text]))
        and brokerage_id = public.current_user_brokerage_id())
  );

-- thank_you_note_templates — the tenant branch resolves through `agents`, not
-- `users`. Preserved EXACTLY, for m406's stated reason: normalising it to
-- current_user_brokerage_id() would widen the gate to every authenticated
-- non-agent user, which is a different decision and not this one.
alter policy tyn_templates_owner_insert on public.thank_you_note_templates
  with check (
    public.is_platform_staff()
    or brokerage_id = (select agents.brokerage_id from public.agents
                        where agents.user_id = auth.uid() limit 1)
  );
alter policy tyn_templates_owner_update on public.thank_you_note_templates
  using (
    public.is_platform_staff()
    or brokerage_id = (select agents.brokerage_id from public.agents
                        where agents.user_id = auth.uid() limit 1)
  )
  with check (
    public.is_platform_staff()
    or brokerage_id = (select agents.brokerage_id from public.agents
                        where agents.user_id = auth.uid() limit 1)
  );
alter policy tyn_templates_owner_delete on public.thank_you_note_templates
  using (
    public.is_platform_staff()
    or brokerage_id = (select agents.brokerage_id from public.agents
                        where agents.user_id = auth.uid() limit 1)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- support_tickets — THE ONE TABLE WHERE SELECT MOVES TOO, AND WHY THAT IS NOT A
-- QUIET EXCEPTION.
--
-- m406 gave support_tickets `is_platform_admin() OR brokerage_id = <tenant>` on
-- ALL FOUR commands, SELECT included (correctly — an untenanted ticket is not
-- everyone's ticket, so it lost the NULL branch rather than keeping it).
--
-- Swapping only the write side here would have been INERT. Postgres evaluates the
-- SELECT policy for any UPDATE or DELETE whose WHERE clause reads a column — which
-- is every one of them, since a ticket is updated by id. A `support` operator
-- granted UPDATE but not SELECT can still not touch a single row; the migration
-- would have looked applied and changed nothing. Widening SELECT in lockstep is
-- what makes the write swap real.
--
-- This does NOT re-open the tenant escape m406 closed: the NULL branch is not
-- coming back, and the widening is strictly from "the one superadmin" to "the four
-- staff roles the owner named". A support role that cannot read a support ticket
-- is the plainest contradiction of the ruling in the schema.
-- ─────────────────────────────────────────────────────────────────────────────
alter policy support_tickets_tenant_select on public.support_tickets
  using      (public.is_platform_staff() or brokerage_id = public.current_user_brokerage_id());
alter policy support_tickets_tenant_insert on public.support_tickets
  with check (public.is_platform_staff() or brokerage_id = public.current_user_brokerage_id());
alter policy support_tickets_tenant_update on public.support_tickets
  using      (public.is_platform_staff() or brokerage_id = public.current_user_brokerage_id())
  with check (public.is_platform_staff() or brokerage_id = public.current_user_brokerage_id());
alter policy support_tickets_tenant_delete on public.support_tickets
  using      (public.is_platform_staff() or brokerage_id = public.current_user_brokerage_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- knowledge_articles — ADDITIVE, NOT A REWRITE, AND THAT IS THE CAREFUL CHOICE.
--
-- Its write gate lives inside `knowledge_articles_admin`, a single FOR ALL policy
-- (`is_platform_admin() OR (is_brokerage_admin() AND has_brokerage_access(brokerage_id))`).
-- ALTERing that policy would move SELECT as well, because FOR ALL is one
-- expression for all four commands — and the brief for this wave is write-side
-- only. Splitting it into four policies would also collide with another agent
-- working the tenant-owned KB surfaces this same wave.
--
-- So the existing policy is left untouched and three staff-only write policies are
-- ADDED alongside it. Permissive policies OR together, so this grants the four
-- staff roles INSERT/UPDATE/DELETE while the superadmin and brokerage-admin paths
-- keep working through the policy that already expresses them, and SELECT is not
-- reached at all.
--
-- No tenant branch is repeated in these three: the brokerage-admin path already
-- exists in knowledge_articles_admin, and duplicating it here would create a
-- second place to get it wrong.
-- ─────────────────────────────────────────────────────────────────────────────
create policy knowledge_articles_staff_insert on public.knowledge_articles
  for insert to authenticated
  with check (public.is_platform_staff());

create policy knowledge_articles_staff_update on public.knowledge_articles
  for update to authenticated
  using      (public.is_platform_staff())
  with check (public.is_platform_staff());

create policy knowledge_articles_staff_delete on public.knowledge_articles
  for delete to authenticated
  using      (public.is_platform_staff());

-- ─────────────────────────────────────────────────────────────────────────────
-- DELIBERATELY NOT SWAPPED — READ THIS BEFORE "FINISHING THE JOB".
--
--  * service_status. It was on the candidate list and it does not belong there.
--    Its columns are last_checked_at, last_healthy_at, consecutive_failures,
--    response_time_ms, error_message, current_status — machine telemetry, not
--    catalogue content. Its ONLY writer is the health-check cron
--    (app/api/cron/health-check/route.ts), which runs on the SERVICE client and
--    bypasses RLS entirely, so widening the policy grants no legitimate human
--    workflow anything at all. What it WOULD grant is the ability for a marketing
--    or support account to hand-forge platform health telemetry — to declare an
--    outage, or clear a real one — on the surface tenants read to decide whether
--    the platform is up. The ruling names who the staff are; it does not say a
--    marketing user may publish an outage. Left on is_platform_admin(), and m409
--    PINS that so a future copy-paste cannot quietly complete the pattern.
--
--  * api_response_logs. Same reasoning, one step stronger: platform telemetry,
--    service-client-only writer (lib/agentic-os/connector-gateway.ts), and its
--    tenant read was already dead code per m406. Nothing human writes it.
--
--  * buyer_stage_coaching. It is on the ruling's content list, and it has NO write
--    policy to swap — after m406's consolidation it carries exactly one policy,
--    bsc_read_brokerage, FOR SELECT. INSERT/UPDATE/DELETE are therefore
--    default-denied to every RLS-bound caller including the superadmin, and
--    granting them is authoring new write access, not applying a roster — a
--    different change, with a different blast radius, that should be made
--    deliberately and asserted on its own. Reported rather than smuggled in here.
--
--  * is_platform_admin() itself. Untouched. 522 policies / 179 tables depend on it
--    meaning superadmin. m409 asserts its roster has not moved.
