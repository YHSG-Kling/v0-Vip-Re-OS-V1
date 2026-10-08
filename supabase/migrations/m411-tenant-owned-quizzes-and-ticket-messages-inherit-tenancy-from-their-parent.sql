-- m411 — the two CHILD tables in the tenant-content surface carry no brokerage_id
--        of their own, so their tenancy can only come from a join to the parent.
--        Neither of them made that join. Measured live, not reasoned about.
--
-- THE DEFECT #1 — onboarding_quizzes LEAKED TENANT CONTENT TO THE OPEN INTERNET
--
-- Its four policies were:
--     oq_select  FOR SELECT  USING (true)              -- granted to PUBLIC
--     oq_ins     FOR INSERT  WITH CHECK (is_platform_admin())
--     oq_upd     FOR UPDATE  USING/CHECK (is_platform_admin())
--     oq_del     FOR DELETE  USING (is_platform_admin())
--
-- Not one of them mentions onboarding_steps, the parent that actually holds the
-- brokerage_id. Probed live inside a rolled-back transaction: a platform admin
-- created a step owned by brokerage b0000000-…-0001 and a quiz on it whose
-- questions jsonb held {"correctAnswer":"TENANT-A-SECRET"}. Then, re-running as
-- the admin of a DIFFERENT brokerage (231f4e64-…), and again as `anon`:
--
--     caller                     sees A's step   sees A's QUIZ
--     tenant B admin                    0 rows   1 row  → "A PRIVATE QUIZ / TENANT-A-SECRET"
--     anon (unauthenticated)                 —   1 row  → "A PRIVATE QUIZ / TENANT-A-SECRET"
--
-- The parent step was correctly hidden from tenant B. The quiz hanging off it —
-- including the answer key — was readable by every other tenant AND by callers
-- with no session at all. `USING (true)` to PUBLIC is not a tenancy predicate.
-- The 8 quizzes live today all hang off platform steps, so what leaks TODAY is
-- the platform answer key to the open internet; the moment a tenant owns a quiz
-- it becomes cross-tenant as proven above.
--
-- THE DEFECT #2 — A TENANT COULD NEVER AUTHOR A QUIZ FOR ITS OWN STEP
--
-- The same probe, as the brokerage admin of b0000000-…-0001, on a step that
-- admin had just created and owns:
--
--     INSERT onboarding_quizzes(step_id = <own step>)
--       → "new row violates row-level security policy for table onboarding_quizzes"
--
-- The write side is `is_platform_admin()` and nothing else, so a tenant that CAN
-- author its own onboarding steps (app/actions/admin/onboarding-steps.ts and
-- app/actions/onboarding/onboarding-steps-admin-actions.ts both do exactly that)
-- can never attach a quiz to one. That is the half of the owner's ruling —
-- "tenants will also have their own … onboarding … under their own brokerageid" —
-- that has never been exercised.
--
-- THE DEFECT #3 — support_ticket_messages HAD EXACTLY ONE POLICY
--
-- `tenant_read_support_ticket_messages`, FOR SELECT. INSERT/UPDATE/DELETE were
-- therefore default-DENIED. Probed live as the tenant admin, on a ticket that
-- admin had just created and owns:
--
--     INSERT support_ticket_messages(ticket_id = <own ticket>)
--       → "new row violates row-level security policy"
--
-- This is the content_topic_sources shape m406 found, with ONE difference that
-- matters and is stated here rather than glossed: the app does NOT break today,
-- because every writer of this table is the SERVICE client, which bypasses RLS
-- entirely (lib/support/support-thread.ts:49 postTicketReply, reached from
-- app/actions/support.ts replyToMyTicket / replyToBrokerageTicket and from the
-- superadmin console). So this is not a broken feature — it is a table whose
-- policy set cannot express the writes the product performs, which means the
-- only thing standing between a tenant and another tenant's support thread is
-- application code. The INSERT policy below gives that reach a policy-level
-- basis, scoped through the parent ticket, exactly as the SELECT already is.
--
-- Its SELECT also could not admit platform staff: it tests
-- `t.brokerage_id IN (SELECT user_brokerage_ids())`, and a platform admin's
-- brokerage is their own, not the ticket's. m406 gave the PARENT
-- (support_tickets_tenant_select) `is_platform_admin() OR …`; the child is
-- brought in line so the platform console can read a thread on the RLS rail and
-- not only on the service key.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
--
--  * It does NOT add UPDATE/DELETE to support_ticket_messages. A support thread
--    is an audit trail, no application path edits or removes a message, and
--    inventing those two policies would be granting writes nobody performs.
--    They stay default-denied, on purpose.
--  * It does NOT touch learning_modules.brokerage_id, which is NOT NULL and
--    therefore makes a platform-provided course structurally impossible. That is
--    a schema change with a blast radius (lm_admin_write, lm_tenant_select, the
--    learning_assignments FK and every reader) and is reported, not half-built.

-- ─────────────────────────────────────────────────────────────────────────────
-- onboarding_quizzes — tenancy is the parent step's, on all four commands.
--
-- SELECT restates the parent's own predicate (brokerage_id IS NULL OR mine)
-- rather than leaning on the fact that onboarding_steps' RLS is also applied
-- inside this subquery. Both are true; writing it out means the next reader does
-- not have to know the subtle one, and the policy still says what it means if
-- the parent's own SELECT is ever widened.
--
-- The three WRITE policies drop the `IS NULL` branch: a platform quiz is shared
-- READING, never shared WRITING — the same read/write split m406 established.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists oq_select on public.onboarding_quizzes;
drop policy if exists oq_ins    on public.onboarding_quizzes;
drop policy if exists oq_upd    on public.onboarding_quizzes;
drop policy if exists oq_del    on public.onboarding_quizzes;

create policy onboarding_quizzes_read on public.onboarding_quizzes
  for select to authenticated
  using (
    exists (
      select 1 from public.onboarding_steps s
       where s.id = onboarding_quizzes.step_id
         and (s.brokerage_id is null
              or s.brokerage_id = public.current_user_brokerage_id())
    )
  );

create policy onboarding_quizzes_owner_insert on public.onboarding_quizzes
  for insert to authenticated
  with check (
    public.is_platform_admin()
    or exists (
      select 1 from public.onboarding_steps s
       where s.id = onboarding_quizzes.step_id
         and s.brokerage_id = public.current_user_brokerage_id()
    )
  );

create policy onboarding_quizzes_owner_update on public.onboarding_quizzes
  for update to authenticated
  using (
    public.is_platform_admin()
    or exists (
      select 1 from public.onboarding_steps s
       where s.id = onboarding_quizzes.step_id
         and s.brokerage_id = public.current_user_brokerage_id()
    )
  )
  with check (
    public.is_platform_admin()
    or exists (
      select 1 from public.onboarding_steps s
       where s.id = onboarding_quizzes.step_id
         and s.brokerage_id = public.current_user_brokerage_id()
    )
  );

create policy onboarding_quizzes_owner_delete on public.onboarding_quizzes
  for delete to authenticated
  using (
    public.is_platform_admin()
    or exists (
      select 1 from public.onboarding_steps s
       where s.id = onboarding_quizzes.step_id
         and s.brokerage_id = public.current_user_brokerage_id()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- support_ticket_messages — the read gains platform staff; INSERT gains a policy
-- at all. user_brokerage_ids() is preserved verbatim on both sides (it unions
-- users.brokerage_id with agents.brokerage_id); swapping it for
-- current_user_brokerage_id() would NARROW the read for agent-resolved users,
-- which is not what this wave was asked to decide.
-- ─────────────────────────────────────────────────────────────────────────────
alter policy tenant_read_support_ticket_messages on public.support_ticket_messages
  using (
    public.is_platform_admin()
    or exists (
      select 1 from public.support_tickets t
       where t.id = support_ticket_messages.ticket_id
         and t.brokerage_id in (select public.user_brokerage_ids())
    )
  );

create policy support_ticket_messages_owner_insert on public.support_ticket_messages
  for insert to authenticated
  with check (
    public.is_platform_admin()
    or exists (
      select 1 from public.support_tickets t
       where t.id = support_ticket_messages.ticket_id
         and t.brokerage_id in (select public.user_brokerage_ids())
    )
  );
