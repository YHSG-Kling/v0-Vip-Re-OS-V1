-- m421 — THE PLATFORM SUPPLIES TRAINING THAT TENANTS CONSUME, AND UNTIL NOW THE
--        SCHEMA MADE THAT STRUCTURALLY IMPOSSIBLE.
--
-- THE OWNER'S RULING
--
--   "platform needs the training/learning as well for the tenants."
--
-- THE DEFECT, MEASURED, NOT REASONED ABOUT
--
-- `public.learning_modules.brokerage_id` is NOT NULL. Every other member of the
-- platform catalogue m406/m408 established — onboarding_steps, training_videos,
-- help_topics_kb, offer_strategy_templates, knowledge_articles — carries a
-- NULLABLE brokerage_id, and that nullability IS the platform row: brokerage_id
-- IS NULL means "this row belongs to the platform, every signed-in tenant may
-- read it". learning_modules was never given that. So a platform-provided COURSE
-- could not be inserted at all — not "was not seeded yet", could not exist. The
-- constraint refuses the row before any policy is consulted.
--
-- THE PRODUCT WAS ALREADY WRITTEN FOR THE ROW THAT COULD NOT EXIST
--
-- This is not a feature being invented here. It is a feature that was built,
-- shipped and left inert by one column constraint. Found in the tree, not
-- assumed:
--
--   * app/actions/auth/signup-brokerage.ts:416 seeds a brand-new brokerage's
--     first three courses with `.is("brokerage_id", null)` — it selects PLATFORM
--     modules explicitly. Against a NOT NULL column that query matches zero rows
--     on every signup that has ever run. Every new tenant has been onboarded with
--     an empty shelf.
--   * app/actions/academy-learning.ts:70-71 carries the comment "Brokerage
--     isolation: platform modules (brokerage_id null) are visible to all" and the
--     guard `if (mod.brokerage_id && mod.brokerage_id !== ctx.brokerageId)` —
--     already written to admit the untenanted row.
--   * lib/education/content-freshness.ts:81 and lib/education/dedup-guard.ts:77
--     and :111 already read
--     `.or("brokerage_id.eq.<id>,brokerage_id.is.null")` with the comment
--     "Brokerage modules + platform-wide (null brokerage) AI modules."
--
-- Four call sites across three subsystems already spelled the platform course.
-- The column is what made all four dead code.
--
-- WHAT THIS FILE DOES, MIRRORING m406/m408 RATHER THAN INVENTING A SHAPE
--
--   1. brokerage_id becomes NULLABLE. This is the whole structural change; the
--      policy work below is what keeps it from being a tenant escape.
--   2. SELECT becomes `brokerage_id IS NULL OR brokerage_id = <caller's tenant>`
--      — m406's read rule verbatim: a tenant sees its own rows PLUS the
--      platform's.
--   3. The FOR ALL write policy is replaced by three gated write policies whose
--      platform branch is `is_platform_staff()` — m408's four-role helper
--      (superadmin, admin, marketing, support).
--
-- THE ANON HALF, WHICH IS THE DANGEROUS PART AND IS NOT OPTIONAL
--
-- Both policies on this table are granted to PUBLIC (polroles = {0}), verified
-- against pg_policy, not assumed. Today that leaks nothing: the only read rule is
-- `brokerage_id = current_user_brokerage_id()`, and for an anonymous caller that
-- helper returns NULL, so the predicate is `brokerage_id = NULL` → NULL → false,
-- and anon reads zero rows.
--
-- The moment SELECT gains `brokerage_id IS NULL`, that arithmetic INVERTS. The new
-- disjunct does not mention the caller at all — it is true of the platform row for
-- EVERY caller, including one with no auth.uid(). Dropping the NOT NULL and
-- widening SELECT while leaving the grant at PUBLIC would publish the platform's
-- entire course catalogue — body text, quiz questions and answers included — to
-- the open internet, readable through the anon key with no account. The tenant-
-- escape waves (m394/m396/m404/m413/m417) exist because that class of mistake was
-- made repeatedly; this is the same mistake wearing a feature's clothes.
--
-- So both policies are narrowed to `authenticated` in the SAME statement that
-- widens them. The ruling says the platform's training is for THE TENANTS —
-- signed-in users of the product — and never says it is public marketing content.
-- m422 asserts the grant, and that assertion is the real point of the pair.
--
-- THE ROLE GATE ON WRITES IS PRESERVED, NOT SIMPLIFIED
--
-- The brief for this wave described the write rule as
-- `is_platform_staff() OR brokerage_id = current_user_brokerage_id()`. Applied
-- literally to THIS table that would be a widening nobody asked for: the existing
-- lm_admin_write also requires
-- `current_user_type() = ANY (ARRAY['broker','broker_admin','admin','superadmin','team_lead'])`,
-- so authoring a course is a broker/admin/team-lead capability today. Dropping
-- that half would hand every authenticated agent in every brokerage the ability to
-- INSERT, UPDATE and DELETE their brokerage's courses.
--
-- m406 hit exactly this on training_videos and resolved it the same way: "The role
-- test is preserved verbatim ... the tenant predicate is ANDed onto it." That
-- precedent is followed here. The role array is reproduced character-for-character
-- from the live policy; only the platform disjunct is new. m422 asserts a role
-- test still exists, as a construct, so this cannot be quietly simplified away
-- later.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH — READ BEFORE "FINISHING THE PATTERN"
--
--  * learning_assignments.brokerage_id STAYS NOT NULL, and that is the point of
--    the boundary rather than an oversight. A module is content and can belong to
--    the platform; an ASSIGNMENT is the record that a particular tenant's agent
--    was given that content, and it always belongs to that tenant. Making it
--    nullable would create completion and quiz-score rows owned by nobody. The FK
--    learning_assignments.module_id -> learning_modules(id) needs no change at
--    all: it targets the id, not the tenant, so a tenant-owned assignment already
--    points at a platform module the moment one exists. (The brief listed "the
--    learning_assignments FK" in the blast radius; measured, it is untouched.)
--
--  * learning_module_channel_publications.brokerage_id also stays NOT NULL — same
--    reasoning, and its second FK to learning_modules is likewise unaffected. A
--    publication records that a TENANT pushed a module to a TENANT's channel.
--
--  * The tenant AUTHORING surfaces stay tenant-scoped on purpose: the approval
--    queue (learning-modules-approvals.ts) still refuses a module whose
--    brokerage_id is not the caller's, so a brokerage admin cannot approve,
--    reject, edit or delete a platform course. Tenants CONSUME the platform
--    catalogue; they do not maintain it. That is is_platform_staff()'s job here.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE STRUCTURAL CHANGE. Everything else in this file exists to make this
--    safe.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.learning_modules
  alter column brokerage_id drop not null;

comment on column public.learning_modules.brokerage_id is
  'Owning tenant, or NULL for a PLATFORM course supplied by the platform and readable by every signed-in tenant (the m406/m408 platform-catalogue convention). NULL is not "unknown" and not "unstamped" — it is a positive claim of platform ownership. A NULL row may be written only by is_platform_staff(); a tenant writes only rows carrying its own brokerage_id. Readers MUST use `.or("brokerage_id.eq.<id>,brokerage_id.is.null")`, never `.eq("brokerage_id", id)`, because `NULL = <uuid>` is NULL and never true — an .eq() reader cannot see a platform course at all.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. READ: the tenant's own courses PLUS the platform's — and `authenticated`
--    only. See "THE ANON HALF" above: the role narrowing is load-bearing, not
--    housekeeping, and must land in the same statement as the widening.
-- ─────────────────────────────────────────────────────────────────────────────
alter policy lm_tenant_select on public.learning_modules
  to authenticated
  using (brokerage_id is null or brokerage_id = public.current_user_brokerage_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. WRITE: a FOR ALL policy is the write vector and cannot be ALTERed into a
--    read-only one, so it is dropped and replaced by three command-specific
--    policies — the same move m406 made on help_topics_kb and training_videos.
--
--    Dropping it costs no read access: FOR ALL also served SELECT, but every row
--    it admitted (`brokerage_id = current_user_brokerage_id()` AND a role test) is
--    a strict subset of what lm_tenant_select admits above.
--
--    The UPDATE policy gains a WITH CHECK the FOR ALL never had a separate one
--    for; without it a broker could MOVE a course to another brokerage, or set
--    brokerage_id to NULL and promote their own content into the platform
--    catalogue every other tenant reads. That second case is created by this very
--    migration — before today NULL was unreachable — so the WITH CHECK is part of
--    the change, not a drive-by.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists lm_admin_write on public.learning_modules;

create policy lm_platform_or_owner_insert on public.learning_modules
  for insert to authenticated
  with check (
    public.is_platform_staff()
    or (brokerage_id = public.current_user_brokerage_id()
        and public.current_user_type() = any (array['broker'::text, 'broker_admin'::text, 'admin'::text, 'superadmin'::text, 'team_lead'::text]))
  );

create policy lm_platform_or_owner_update on public.learning_modules
  for update to authenticated
  using (
    public.is_platform_staff()
    or (brokerage_id = public.current_user_brokerage_id()
        and public.current_user_type() = any (array['broker'::text, 'broker_admin'::text, 'admin'::text, 'superadmin'::text, 'team_lead'::text]))
  )
  with check (
    public.is_platform_staff()
    or (brokerage_id = public.current_user_brokerage_id()
        and public.current_user_type() = any (array['broker'::text, 'broker_admin'::text, 'admin'::text, 'superadmin'::text, 'team_lead'::text]))
  );

create policy lm_platform_or_owner_delete on public.learning_modules
  for delete to authenticated
  using (
    public.is_platform_staff()
    or (brokerage_id = public.current_user_brokerage_id()
        and public.current_user_type() = any (array['broker'::text, 'broker_admin'::text, 'admin'::text, 'superadmin'::text, 'team_lead'::text]))
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. learning_assignments' two policies are ALSO granted to PUBLIC, and this
--    file narrows them to `authenticated` while it is here — for a different and
--    smaller reason than above.
--
--    They are not being widened, so there is no new leak. But la_agent_self's
--    first disjunct is `agent_user_id = auth.uid()`, and for an anonymous caller
--    auth.uid() is NULL, so it is already false — the PUBLIC grant buys anon
--    nothing today and is pure surplus reach on a table that is about to start
--    carrying assignments pointing at platform courses. Removing it costs nothing
--    real and keeps the whole learning surface on one rule: signed in, or nothing.
-- ─────────────────────────────────────────────────────────────────────────────
alter policy la_agent_self  on public.learning_assignments to authenticated;
alter policy la_self_update on public.learning_assignments to authenticated;
