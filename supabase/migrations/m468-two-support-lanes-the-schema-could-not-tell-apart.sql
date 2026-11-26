-- m468 — TWO SUPPORT LANES THE SCHEMA COULD NOT TELL APART
--
-- Owner ruling, verbatim: "support is for submitting support tickets to platform
-- from tenant and also agents and vendors support ticket to the brokerage office
-- staff. the platform has support and marketing roles which last time i
-- mentioned them for the tenants which i was incorrect."
--
-- That is TWO conversations, not one:
--
--   LANE 1  tenant → PLATFORM. A brokerage raises a ticket to the platform.
--           Answered by platform staff holding platform_role 'support'.
--   LANE 2  agent or vendor → THEIR OWN BROKERAGE'S OFFICE STAFF. Raised inside
--           one tenant, answered inside that tenant. THE PLATFORM IS NOT A PARTY.
--
-- ── MEASURED BEFORE WRITING, ON THE LIVE DATABASE ───────────────────────────
--
-- public.support_tickets columns:
--   id, brokerage_id, agent_id, contact_id, subject, description, status,
--   priority, category, created_at, updated_at, assigned_to, first_response_at,
--   resolved_at, satisfaction_rating, satisfaction_comment, satisfaction_at
--
-- ALL FOUR policies on support_tickets were the SAME predicate, character for
-- character:
--   support_tickets_tenant_select  USING       is_platform_staff() OR brokerage_id = current_user_brokerage_id()
--   support_tickets_tenant_insert  WITH CHECK  is_platform_staff() OR brokerage_id = current_user_brokerage_id()
--   support_tickets_tenant_update  USING + WC  is_platform_staff() OR brokerage_id = current_user_brokerage_id()
--   support_tickets_tenant_delete  USING       is_platform_staff() OR brokerage_id = current_user_brokerage_id()
--
-- And on the child table:
--   tenant_read_support_ticket_messages        USING       is_platform_admin() OR EXISTS(parent ticket in user_brokerage_ids())
--   support_ticket_messages_owner_insert       WITH CHECK  is_platform_admin() OR EXISTS(parent ticket in user_brokerage_ids())
--
-- support_tickets: 0 rows. support_ticket_messages: 0 rows. NOTHING to backfill,
-- no data migration, and no risk of locking a live table — which is why the lane
-- can be added NOT NULL with NO DEFAULT (see below).
--
-- MEASURED: zero triggers and zero functions in `public` reference
-- support_tickets, so no database-side writer can be broken by a new NOT NULL
-- column. Every writer is application code, and every one of them is edited in
-- the same commit as this migration.
--
-- ── THREE DEFECTS THIS CLOSES ───────────────────────────────────────────────
--
-- (1) NO LANE DISCRIMINATOR. Nothing in the schema separated the two lanes the
--     ruling describes, so neither could be routed, listed, or scoped. The
--     platform's support console, its SLA clock and its home-page counter all
--     read EVERY ticket in the database — including brokerage-internal ones the
--     platform is not answering — and the tenant's own office queue read the
--     tenant's tickets TO the platform as though they were its own work.
--
-- (2) NO VENDOR SUBMITTER. The table carried agent_id and contact_id and no
--     vendor_id, while the ruling says vendors raise tickets to the brokerage. A
--     vendor could not be recorded as the submitter at all.
--
-- (3) EVERY TENANT USER COULD READ EVERY TICKET IN THEIR BROKERAGE. The SELECT
--     policy was tenant-wide, so one agent read another agent's support ticket,
--     and a LANE 1 ticket a broker raised to the platform was readable by every
--     authenticated user in the tenant — including, MEASURED on this database's
--     live users table, user_type 'contact', 'vendor' and 'lender' accounts.
--     That contradicts the other half of the same ruling: "users are users with
--     no rights except seeing their own work."
--
--     This defect lived AT the database boundary, not in the app: the server
--     actions read support_tickets through the SERVICE client, which bypasses
--     RLS entirely, and their own filters were already agent-scoped. The hole
--     was reachable by any authenticated client holding the anon key and a user
--     JWT, which is every browser session this product ships.
--
-- ── WHY submitted_by_user_id AND NOT vendor_id ALONE ────────────────────────
-- MEASURED: public.vendors has NO user column at all — its columns are
-- id, name, category, email, phone, website, rating, notes, created_at,
-- updated_at, brokerage_id, estimated_turnaround_days, access_level, status,
-- ai_verification_score, verification_flags, verified_at, verified_by,
-- compliance_credentials, access_expires_at, invited_by_user_id,
-- invited_by_team_id, preferred, display_priority, visible_in_portal,
-- audience_tags, stage_tags, team_id.
--
-- So vendor_id records WHICH VENDOR raised the ticket (the fact the ruling asks
-- for) but cannot on its own answer "is the caller that vendor". The only live
-- user→vendor linkage is user_role_assignments.vendor_id, and MEASURED there are
-- ZERO rows with vendor_id set today — the branch is shape-correct and storable
-- (user_role_assignments.role has no CHECK constraint) but currently matches
-- nobody, and this migration says so rather than implying it is exercised.
--
-- agent_id has the same limit from the other side: it answers "is the caller the
-- submitter" only for users who HAVE an agents row, and a tc / isa / office
-- admin does not. submitted_by_user_id is the auth-level submitter — the one
-- column that answers the question for every class of tenant user — so it is
-- what the visibility test leans on, with the agents and vendor-grant paths kept
-- beside it because different writers in the tree set different subsets.
--
-- ── WHY THE LANE IS NOT NULL WITH NO DEFAULT ────────────────────────────────
-- A default would make a forgotten lane invisible: the row would land in
-- whichever lane the default names and be routed to the wrong audience, silently.
-- With no default a writer that forgets the lane gets 23502 — loud, at the write,
-- in the log. The table is empty so nothing is being broken to get that.
--
-- ── ONE PREDICATE FOR READ AND WRITE, DELIBERATELY ─────────────────────────
-- SELECT, INSERT and UPDATE all compose public.can_access_support_ticket().
-- m467 is the reason: it found a gate that admitted a write and refused the
-- corresponding read, and recorded that this is not a narrower policy but a
-- broken one. The converse breaks the feature instead — a submitter who can read
-- their ticket and not reply to it cannot use it. One function, so the two can
-- never drift.
--
-- DELETE is the exception and is strictly NARROWER: destroying a support record
-- is an administrative act, so it is platform staff or the tenant's own
-- admin-class and nobody else. Before this migration any authenticated user in
-- the tenant could delete any ticket in it.
--
-- ── WHY is_brokerage_admin() AND NOT A NEW ADMIN TEST ──────────────────────
-- Because m466 already made that function count a tenant ROLE GRANT in
-- user_role_assignments as well as users.user_type, and m467 recorded the cost of
-- letting a second definition of "administers this brokerage" exist. A new test
-- here would refuse the grant-only second seat the owner's two-seat ruling
-- creates. It is composed as-is.
--
-- ── THE PLATFORM-STAFF ESCAPE IS UNCHANGED ─────────────────────────────────
-- public.is_platform_staff() stays the first branch of the predicate, exactly as
-- the four superseded policies had it: platform_role IN (superadmin, admin,
-- marketing, support) OR user_type IN (superadmin, super_admin). The platform
-- can still reach a lane 2 ticket at the database boundary for break-glass. What
-- changes is the APP: the platform support console lists and acts on lane 1 only,
-- because the ruling says the platform is not a party to lane 2. RLS keeps the
-- door; the product stops walking through it by accident.
--
-- ── THE CHILD TABLE IS NARROWED TOO ────────────────────────────────────────
-- Leaving support_ticket_messages tenant-wide would leave defect (3) wide open
-- through the back door: the ticket row would be hidden and the CONVERSATION
-- readable. Both message policies now inherit the parent ticket's predicate,
-- which is m411/m412's own rule (a tenant-owned child inherits tenancy from its
-- parent) applied to a predicate that is no longer merely tenancy.
--
-- That is a NARROWING for tenant users and a deliberate WIDENING for platform
-- staff: the message policies tested is_platform_admin() (MEASURED:
-- platform_role = 'superadmin' OR user_type IN (superadmin, super_admin)) while
-- the TICKET policies tested is_platform_staff(). A platform_role='support'
-- staffer could therefore read the ticket and NOT the thread they exist to
-- answer. Aligning both tables on one predicate closes that too.
--
-- ── THE SQL RULES THIS FILE OBEYS ──────────────────────────────────────────
--   * coalesce(..., false) wraps the WHOLE or-chain in every function. `x =
--     auth.uid()` is NULL when auth.uid() is NULL and NULL propagates through OR,
--     so a boolean helper can otherwise answer NULL — safe in RLS by accident,
--     a trap for anything that composes it. m465 shipped that bug; m466 and m467
--     recorded it. Could-not-establish = no.
--   * EXISTS against user_role_assignments, never a single-row read: it is UNIQUE
--     on (user_id, role) and NOT on user_id, so several grants per user is legal
--     AND LIVE (7 grant rows, two users holding several).
--   * public.current_user_led_team_id() is NOT used anywhere here. It ends
--     LIMIT 1 and refuses a lead of two teams; m465 reported it rather than
--     changing it underneath its other callers.
--
-- IDEMPOTENT. Safe to re-run.

begin;

-- ── THE COLUMNS ─────────────────────────────────────────────────────────────

alter table public.support_tickets add column if not exists lane text;
alter table public.support_tickets add column if not exists vendor_id uuid;
alter table public.support_tickets add column if not exists submitted_by_user_id uuid;

-- 0 rows measured, so this is a no-op today. It is here so a RE-RUN after rows
-- exist cannot fail on the NOT NULL below, and it names the lane a row would be
-- assumed into if that ever happened — the brokerage-internal one, which is the
-- lane that does NOT reach the platform. An unlabelled row must not be escalated
-- out of its tenant by default.
update public.support_tickets set lane = 'user_to_brokerage' where lane is null;

alter table public.support_tickets alter column lane set not null;

-- No DEFAULT on purpose. See the header: a default routes a forgotten lane
-- silently; 23502 reports it.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'support_tickets_lane_check') then
    -- Written in the ADD CONSTRAINT … = ANY (ARRAY[…]) form on purpose:
    -- scripts/vocabulary-snapshot-guard.ts parses exactly that shape out of the
    -- migrations directory and asserts scripts/check-vocabularies.ts agrees with
    -- it, so a vocabulary declared any other way rots the snapshot silently.
    ALTER TABLE public.support_tickets
      ADD CONSTRAINT support_tickets_lane_check
      CHECK (lane = ANY (ARRAY['user_to_brokerage'::text, 'tenant_to_platform'::text]));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'support_tickets_vendor_id_fkey') then
    alter table public.support_tickets
      add constraint support_tickets_vendor_id_fkey
      foreign key (vendor_id) references public.vendors(id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'support_tickets_submitted_by_user_id_fkey') then
    alter table public.support_tickets
      add constraint support_tickets_submitted_by_user_id_fkey
      foreign key (submitted_by_user_id) references public.users(id);
  end if;
end $$;

comment on column public.support_tickets.lane is
  'WHICH SUPPORT CONVERSATION this ticket is. tenant_to_platform = the brokerage raising a ticket TO the platform, answered by platform_role support staff. user_to_brokerage = an agent or a vendor raising a ticket to their OWN brokerage''s office staff; the platform is not a party to it. NOT NULL with no default: a forgotten lane must fail loudly, not route silently.';
comment on column public.support_tickets.vendor_id is
  'The VENDOR that raised this ticket, for the user_to_brokerage lane. public.vendors has no user column, so this records which vendor without answering "is the caller that vendor" — that question is answered by a user_role_assignments.vendor_id grant.';
comment on column public.support_tickets.submitted_by_user_id is
  'The users.id that actually filed the ticket. The one submitter fact that works for every class of tenant user: agent_id only answers for users holding an agents row, and vendor_id only through a role grant.';

-- Indexes for the two queries the lane split creates: the platform console
-- (lane + status) and "my tickets" (submitter).
create index if not exists support_tickets_lane_status_idx
  on public.support_tickets (lane, status);
create index if not exists support_tickets_submitted_by_idx
  on public.support_tickets (submitted_by_user_id);

-- ── THE SUBMITTER TEST ──────────────────────────────────────────────────────
-- SECURITY DEFINER because it reads agents and user_role_assignments to answer a
-- question about the CALLER'S OWN identity. Under the caller's own RLS those
-- reads could be refused, and a refused authorisation read is indistinguishable
-- from "not the submitter" — which would fail the gate closed against the very
-- person whose ticket it is. It returns a boolean about the caller and leaks no
-- rows.
create or replace function public.is_support_ticket_submitter(
  p_agent_id             uuid,
  p_vendor_id            uuid,
  p_submitted_by_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  -- coalesce WRAPS THE WHOLE OR-CHAIN. Each branch compares against auth.uid(),
  -- which is NULL for an unauthenticated caller, and `NULL or NULL` is NULL, not
  -- false. RLS reads NULL as unsatisfied so it would fail closed anyway; a
  -- boolean function that answers NULL is still a trap for anything composing
  -- it, and can_access_support_ticket() composes this one.
  select coalesce(
    -- THE AUTH-LEVEL SUBMITTER. Works for every class of tenant user, which is
    -- why it is first and why the column was added.
    (p_submitted_by_user_id is not null and p_submitted_by_user_id = auth.uid())

    -- THE AGENT PATH. agents.id and users.id are two different id spaces on this
    -- schema, so the join is explicit rather than assumed: support_tickets.agent_id
    -- is an agents.id (FK support_tickets_agent_id_fkey), and agents.user_id is
    -- the users.id auth.uid() belongs to.
    or (p_agent_id is not null and exists (
      select 1 from public.agents a
      where a.id = p_agent_id and a.user_id = auth.uid()
    ))

    -- THE VENDOR PATH. The ONLY live user→vendor linkage on this schema, because
    -- public.vendors carries no user column (MEASURED). EXISTS, not a single-row
    -- read: user_role_assignments is UNIQUE on (user_id, role) and NOT on
    -- user_id, so one user legitimately holds several grants.
    --
    -- REPORTED, NOT HIDDEN: zero rows in user_role_assignments carry a vendor_id
    -- today, so this branch is reachable but currently matches nobody.
    or (p_vendor_id is not null and exists (
      select 1 from public.user_role_assignments ura
      where ura.user_id = auth.uid() and ura.vendor_id = p_vendor_id
    )),
    false  -- could-not-establish = no
  );
$$;

comment on function public.is_support_ticket_submitter(uuid, uuid, uuid) is
  'Is the caller the person who raised this support ticket? Three independent paths — submitted_by_user_id (every user class), agents.user_id (agent submitters), user_role_assignments.vendor_id (vendor submitters, the only user->vendor linkage on this schema).';

-- ── THE LANE-AWARE ACCESS PREDICATE ─────────────────────────────────────────
create or replace function public.can_access_support_ticket(
  p_lane                 text,
  p_brokerage_id         uuid,
  p_agent_id             uuid,
  p_vendor_id            uuid,
  p_submitted_by_user_id uuid,
  p_assigned_to          uuid
) returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(
    -- THE PLATFORM-STAFF ESCAPE, CARRIED THROUGH UNCHANGED. This is the exact
    -- first branch the four superseded policies had. Every platform account
    -- admitted before this migration is still admitted after it.
    public.is_platform_staff()

    -- Everything below is inside ONE tenant. The tenant test is retained, not
    -- replaced: the lane gate is ON TOP of it, the same way m465 layered the
    -- grain gate on top of the tenant test rather than swapping one for the
    -- other.
    or (
      p_brokerage_id is not null
      and p_brokerage_id = public.current_user_brokerage_id()
      and (
        -- LANE 1 — the tenant speaking to the PLATFORM. The tenant's admin-class
        -- and nobody else inside the tenant. There is deliberately no submitter
        -- branch here: a lane 1 ticket may only be RAISED by admin-class (the
        -- same predicate gates the INSERT below), so the submitter is already
        -- admin-class and a separate branch would only widen the audience.
        (p_lane = 'tenant_to_platform' and public.is_brokerage_admin())

        -- LANE 2 — an agent or vendor speaking to THEIR OWN OFFICE. The
        -- submitter, the assignee, and the brokerage's admin-class staff. NOT
        -- every user in the tenant, which is what the superseded policy allowed.
        or (p_lane = 'user_to_brokerage' and (
          public.is_brokerage_admin()
          or public.is_support_ticket_submitter(p_agent_id, p_vendor_id, p_submitted_by_user_id)
          or (p_assigned_to is not null and p_assigned_to = auth.uid())
        ))

        -- NOTE THE BRANCH THAT IS ABSENT: there is no `else`. A lane value this
        -- function does not recognise reaches no clause and the row is
        -- unreachable inside the tenant. The CHECK constraint already makes such
        -- a value unstorable; this fails closed if that constraint is ever
        -- dropped, instead of falling through to the wider of the two lanes.
      )
    ),
    false  -- could-not-establish = no
  );
$$;

comment on function public.can_access_support_ticket(text, uuid, uuid, uuid, uuid, uuid) is
  'RLS predicate for support_tickets SELECT/INSERT/UPDATE and for support_ticket_messages, lane-aware. Platform staff always; inside a tenant, lane tenant_to_platform is admin-class only and lane user_to_brokerage is submitter + assignee + admin-class. One predicate for read and write on purpose (m467: a gate that admits a write and refuses the read is broken, and the converse breaks the feature).';

-- ── THE POLICIES ────────────────────────────────────────────────────────────

drop policy if exists support_tickets_tenant_select on public.support_tickets;
create policy support_tickets_lane_select
  on public.support_tickets
  for select to authenticated
  using (public.can_access_support_ticket(lane, brokerage_id, agent_id, vendor_id, submitted_by_user_id, assigned_to));

drop policy if exists support_tickets_tenant_insert on public.support_tickets;
create policy support_tickets_lane_insert
  on public.support_tickets
  for insert to authenticated
  with check (public.can_access_support_ticket(lane, brokerage_id, agent_id, vendor_id, submitted_by_user_id, assigned_to));

-- UPDATE is gated on BOTH sides, for the reason m465 records: USING says which
-- rows you may touch, WITH CHECK says what you may turn them into. Without the
-- second half a lane 2 submitter could take their own ticket and flip
-- lane = 'tenant_to_platform', escalating a brokerage-internal matter into the
-- platform's queue and out of their own office's — passing the gate on the way
-- in. With it, the new row is re-tested and lane 1 requires admin-class, so the
-- flip is refused. The same composition blocks moving a row to another tenant.
drop policy if exists support_tickets_tenant_update on public.support_tickets;
create policy support_tickets_lane_update
  on public.support_tickets
  for update to authenticated
  using      (public.can_access_support_ticket(lane, brokerage_id, agent_id, vendor_id, submitted_by_user_id, assigned_to))
  with check (public.can_access_support_ticket(lane, brokerage_id, agent_id, vendor_id, submitted_by_user_id, assigned_to));

-- DELETE — strictly narrower than access, and written inline rather than as a
-- third function because it is a DIFFERENT rule, not a variation of one: nobody
-- inside the tenant but its admin-class may destroy a support record, in either
-- lane. Before this migration every authenticated user in the tenant could.
drop policy if exists support_tickets_tenant_delete on public.support_tickets;
create policy support_tickets_admin_delete
  on public.support_tickets
  for delete to authenticated
  using (
    public.is_platform_staff()
    or (
      brokerage_id is not null
      and brokerage_id = public.current_user_brokerage_id()
      and public.is_brokerage_admin()
    )
  );

-- ── THE CHILD TABLE INHERITS THE PARENT'S PREDICATE ─────────────────────────
-- m411/m412's rule (a tenant-owned child inherits tenancy from its parent),
-- applied now that the parent's predicate is more than tenancy. The EXISTS shape
-- is carried over from the policies being superseded.

drop policy if exists tenant_read_support_ticket_messages on public.support_ticket_messages;
create policy support_ticket_messages_parent_select
  on public.support_ticket_messages
  for select to authenticated
  using (exists (
    select 1 from public.support_tickets t
    where t.id = support_ticket_messages.ticket_id
      and public.can_access_support_ticket(t.lane, t.brokerage_id, t.agent_id, t.vendor_id, t.submitted_by_user_id, t.assigned_to)
  ));

drop policy if exists support_ticket_messages_owner_insert on public.support_ticket_messages;
create policy support_ticket_messages_parent_insert
  on public.support_ticket_messages
  for insert to authenticated
  with check (exists (
    select 1 from public.support_tickets t
    where t.id = support_ticket_messages.ticket_id
      and public.can_access_support_ticket(t.lane, t.brokerage_id, t.agent_id, t.vendor_id, t.submitted_by_user_id, t.assigned_to)
  ));

commit;

-- ── MEASURED AFTER APPLYING, ON THE LIVE DATABASE ───────────────────────────
-- Real accounts, impersonated by setting request.jwt.claims to that user's id
-- under `set local role authenticated`, against seeded rows in brokerage
-- b0000000-0000-0000-0000-000000000001 (call it B0) and one row in
-- 231f4e64-5022-4752-8047-696886551c35. Every seeded row deleted afterwards.
-- RESIDUE: support_tickets 0, support_ticket_messages 0, user_role_assignments
-- back to its pre-existing 7, seeded users 0.
--
-- The seeded fixture: three tickets in B0 — a lane 2 ticket raised by agent
-- agent@vip.demo and assigned to tc@vip.demo, a lane 1 ticket raised by
-- admin@vip.demo, and a lane 2 ticket raised by vendor@vip.demo carrying
-- vendor_id — plus one message on the first, and one lane 2 ticket in the other
-- brokerage.
--
-- SCHEMA
--   lane                    text NOT NULL, no default
--   support_tickets_lane_check CHECK (lane = ANY (ARRAY['user_to_brokerage','tenant_to_platform']))
--   vendor_id               uuid → vendors(id)
--   submitted_by_user_id    uuid → users(id)
--   INSERT omitting lane ................ REFUSED 23502 not_null_violation
--   INSERT with lane='whatever' ......... REFUSED 23514 support_tickets_lane_check
--
-- SELECT — rows actually returned by the policy, per account
--   agent@vip.demo, the lane 2 SUBMITTER ......... 1  (their own, and only it)
--   isa@vip.demo, an unrelated agent in B0 ....... 0
--   tc@vip.demo, the ASSIGNEE .................... 1
--   admin@vip.demo, brokerage admin-class ........ 3  (all three B0 tickets, both lanes)
--   vendor@vip.demo, the VENDOR submitter ........ 1  (their own, not the agent's)
--   buyer@vip.demo, a CONTACT user in B0 ......... 0
--   agent1@yourbrokerage.com — user_type 'agent'
--     holding an 'admin' role GRANT (m466) ....... 1  (their own tenant's only)
--   platform_role='support' staff ................ 4  (every ticket, both tenants)
--
-- THE VENDOR BRANCH, ISOLATED. With submitted_by_user_id set to NULL on the
-- vendor's ticket so only user_role_assignments.vendor_id can answer:
--   vendor@vip.demo .............................. 1
-- That is the branch reached; it is otherwise unexercised, because MEASURED
-- there are ZERO rows in user_role_assignments carrying a vendor_id on this
-- database and the grant above had to be seeded to reach it.
--
-- BEFORE / AFTER, the superseded predicate evaluated under the same identity
-- (`is_platform_staff() OR brokerage_id = current_user_brokerage_id()`, on a B0
-- ticket) beside the new one:
--   isa@vip.demo   superseded TRUE → lane 2 FALSE, lane 1 FALSE
--   buyer@vip.demo (a CONTACT)  superseded TRUE → lane 1 FALSE
-- So before this migration an unrelated agent could read another agent's support
-- ticket, and a client account could read the ticket their brokerage raised to
-- the platform. That is defect (3), measured on both sides.
--
-- support_ticket_messages
--   isa@vip.demo, on agent@vip.demo's thread ..... 0 rows returned
--   platform_role='support' staff ................ 1 row returned
--   and the superseded message predicate for that same support staffer,
--   is_platform_admin() .......................... FALSE
--   while their ticket-side escape, is_platform_staff() .. TRUE
-- A platform support staffer could read the ticket and not the conversation they
-- exist to answer. Both tables now answer the same question the same way.
--
-- WRITE
--   agent@vip.demo flipping their own ticket to
--     lane='tenant_to_platform' .................. REFUSED 42501 (WITH CHECK)
--   isa@vip.demo updating agent@vip.demo's ticket  0 rows written (USING)
--   agent@vip.demo inserting lane 1 ............... REFUSED 42501
--   agent@vip.demo inserting lane 2 naming
--     THEMSELVES as submitter .................... ALLOWED, 1 row
--   agent@vip.demo inserting lane 2 naming
--     isa@vip.demo as the submitter .............. REFUSED 42501
--   agent@vip.demo deleting their own ticket ...... 0 rows deleted
--   admin@vip.demo deleting it .................... ALLOWED, 1 row
--
-- The ALLOWED lines matter as much as the REFUSED ones. A gate that also blocks
-- the submitter, the assignee, the tenant's admin, the grant-only second seat or
-- the platform's support staff is not a fixed gate, it is a different bug.
--
-- STRICT BOOLEANS, not NULL — the failure m465 shipped and m466/m467 recorded:
--   is_support_ticket_submitter(agent, vendor, user) with NO identity at all
--     → false, and `IS NULL` → false
--   can_access_support_ticket(...) with NO identity at all
--     → false, and `IS NULL` → false
--   can_access_support_ticket('user_to_brokerage', NULL brokerage, …)
--     → false
--
-- ── WHAT THIS MIGRATION DOES NOT DO ────────────────────────────────────────
-- It does not narrow the app-side ADMIN_ROLES set in app/actions/support.ts,
-- which admits team_lead and broker_admin where is_brokerage_admin() admits
-- admin, broker and broker_owner. Those server actions read support_tickets
-- through the SERVICE client, which bypasses RLS entirely, so the divergence is
-- not closed by any policy and never was. Narrowing it would remove a team
-- lead's access to their office queue, which is a scope decision this migration
-- has no mandate to make. It is named here so it can be decided on its own terms.
--
-- It also does not give support_tickets an UPDATE or DELETE policy for the
-- `anon` role, or change any grant. The four superseded policies and the two new
-- ones are all `to authenticated`, unchanged.
