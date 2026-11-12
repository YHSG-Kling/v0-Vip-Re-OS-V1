-- m422 — asserts m421.
--
-- Separate file for the m393/m395/m397/m399/m403/m407/m409/m420 reason: a `raise`
-- rolls back its own transaction, so asserting inside m421 would undo the very
-- ALTER TABLE and policy rewrites it was checking and leave learning_modules
-- exactly as closed as before, with a red migration as the only difference.
--
-- IT ASSERTS THE CONSTRUCT, IN THREE DIRECTIONS, AND THE THIRD IS THE ONE THAT
-- WOULD HAVE SHIPPED A BREACH.
--
-- (1) THE STRUCTURAL PRECONDITION. learning_modules.brokerage_id must be
--     NULLABLE. This is asserted first and separately because it is the entire
--     subject of the ruling: with the NOT NULL in place a platform course is not
--     "missing", it is IMPOSSIBLE — the constraint refuses the row before RLS is
--     consulted. Every other clause below is about making that row safe, and all
--     of them can pass while the feature does not exist. Asserted against
--     pg_attribute.attnotnull, not against the presence of the .sql file.
--
-- (2) READ ADMITS THE PLATFORM ROW. At least one permissive SELECT policy must
--     carry `brokerage_id IS NULL`. This is m407(2)'s half, and it is here for the
--     same reason: the naive reading of the tenant-escape work is "strip
--     brokerage_id IS NULL everywhere", and on this table that would leave the
--     platform courses existing in the database and invisible in the product.
--
-- (3) WRITE DOES NOT. No permissive INSERT/UPDATE/DELETE/ALL policy may carry
--     `brokerage_id IS NULL` (m407(1)'s half), and every one of them must gate on
--     is_platform_staff() (m409(3)'s half). Stated as properties over the table
--     rather than as a list of policy names, so a policy dropped and recreated
--     under a new name still has to satisfy them — which is how the migration-029
--     shape spread across 320 tables in the first place.
--
-- (4) THE ANON HALF — THE REASON THIS FILE EXISTS AND NOT JUST m421.
--
--     NO policy on learning_modules may be granted to PUBLIC or to anon.
--
--     Before m421 both policies WERE granted to PUBLIC (polroles = {0}) and that
--     leaked nothing, because the only read rule was
--     `brokerage_id = current_user_brokerage_id()`: for an anonymous caller that
--     helper returns NULL, the predicate is `brokerage_id = NULL` → NULL → false,
--     and anon read zero rows. The PUBLIC grant was harmless ONLY because the
--     predicate happened to mention the caller.
--
--     `brokerage_id IS NULL` does not mention the caller. It is true of the
--     platform row for everyone, authenticated or not. So the exact change the
--     ruling asks for — and nothing else — converts a dormant PUBLIC grant into a
--     live anonymous read of the platform's entire course catalogue: body text,
--     quiz questions and the correct answers, through the anon key, with no
--     account. m421 narrows both policies to `authenticated` in the same statement
--     that widens them; this clause is what makes that permanent, because a future
--     hand re-adding `TO public` would see a policy that still looks correct.
--
--     Checked as polroles, not as text: the grant is invisible in the policy
--     expression, which is exactly why it survived m394/m396/m404/m413/m417.
--
-- (5) THE ROLE GATE SURVIVED. Every write policy must still test
--     current_user_type(). Authoring a course is a broker/broker_admin/admin/
--     superadmin/team_lead capability today; the brief for this wave described the
--     write rule as plain `is_platform_staff() OR brokerage_id = <tenant>`, and
--     applying that literally would have dropped the role test and handed every
--     authenticated agent in every brokerage INSERT/UPDATE/DELETE on their
--     brokerage's courses. Asserted as "a role test exists", NOT as the spelling
--     of the five-name array — per the standing rule, assert the construct, and
--     the roster is a separate decision from this one.
--
-- (6) THE BOUNDARY IS PINNED. learning_assignments.brokerage_id must STAY NOT
--     NULL, and both FKs into learning_modules must survive. An assignment is the
--     record that a specific tenant's agent was given a course — it always belongs
--     to that tenant, and a nullable column there would produce completion and
--     quiz-score rows owned by nobody. The FKs target learning_modules(id), not
--     its tenant, so they need no change for a tenant assignment to point at a
--     platform course; they are pinned because the way this goes wrong is a future
--     hand "completing the pattern" and dropping one.
--
-- WHAT THIS DELIBERATELY DOES NOT ASSERT
--
--  * That any platform course EXISTS. There are 0 rows in learning_modules on this
--    database — the OS has not rolled out. Asserting a row count would be
--    asserting seed data, which is a different wave and would go red the moment
--    someone truncated a table. This file asserts that the row is now POSSIBLE and
--    SAFE; whether the platform has authored one yet is a product question.
--  * The application readers. `.eq("brokerage_id", id)` cannot see a platform row
--    (`NULL = <uuid>` is NULL, never true) and twelve such readers were repaired
--    alongside m421, but that is TypeScript and pg_policy cannot see it. It is
--    covered by the guard chain, not by this file, and is called out here so the
--    gap is deliberate rather than forgotten.
--
-- NEGATIVE CONTROLS, WATCHED RED BEFORE THIS FILE WAS APPLIED:
--   (1) whole body run before m421 → RED at clause (1): brokerage_id is NOT NULL.
--   (4) whole body run before m421 with clauses (1)-(3) removed → RED at (4)
--       naming both PUBLIC-granted policies (lm_admin_write, lm_tenant_select).

do $$
declare
  is_nullable_lm    boolean;
  la_notnull        boolean;
  read_ok           int;
  null_writers      text[];
  unstaffed         text[];
  public_granted    text[];
  roleless_writes   text[];
  fk_n              int;
begin
  -- ── (1) the structural precondition ────────────────────────────────────────
  select not a.attnotnull into is_nullable_lm
  from   pg_attribute a
  join   pg_class     c on c.oid = a.attrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'learning_modules'
    and  a.attname = 'brokerage_id' and a.attnum > 0 and not a.attisdropped;

  if is_nullable_lm is null then
    raise exception 'm422(1): public.learning_modules.brokerage_id does not exist.';
  end if;
  if not is_nullable_lm then
    raise exception
      'm422(1): public.learning_modules.brokerage_id is still NOT NULL, so a platform-provided COURSE is structurally impossible — the constraint refuses the row before any policy is consulted. The ruling is verbatim: "platform needs the training/learning as well for the tenants." Every other member of the platform catalogue (onboarding_steps, training_videos, help_topics_kb, knowledge_articles) already carries a nullable brokerage_id, and that nullability IS the platform row. Note this is not a dormant feature: app/actions/auth/signup-brokerage.ts already seeds each new brokerage with `.is("brokerage_id", null)`, which has matched zero rows on every signup ever run.';
  end if;

  -- ── (2) read admits the platform row ───────────────────────────────────────
  select count(*) into read_ok
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'learning_modules'
    and  p.polpermissive and p.polcmd in ('r','*')
    and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), 'brokerage_id IS NULL') > 0;

  if read_ok = 0 then
    raise exception
      'm422(2): no permissive SELECT policy on learning_modules admits `brokerage_id IS NULL`, so a platform course would exist in the database and be invisible to every tenant in the product. The read rule is m406''s: a tenant sees its own rows PLUS the platform''s. Dropping the NOT NULL without this is the failure mode where the migration looks applied and the feature is absent.';
  end if;

  -- ── (3) write does not admit it, and is gated on platform staff ────────────
  select coalesce(array_agg(p.polname || ' [' || p.polcmd::text || ']' order by p.polname), '{}')
  into   null_writers
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'learning_modules'
    and  p.polpermissive and p.polcmd in ('a','w','d','*')
    and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
                coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
                'brokerage_id IS NULL') > 0;

  if array_length(null_writers, 1) is not null then
    raise exception
      'm422(3): % write polic(ies) on learning_modules admit the untenanted platform row to an ordinary tenant: %. This is the hole m406 closed across the rest of the catalogue, where one agent at one brokerage could UPDATE and DELETE 100%% of the shared onboarding steps, training videos and help articles. A write touching a NULL-tenant row must be gated on is_platform_staff(); a tenant writes only rows carrying its OWN brokerage_id. The WITH CHECK matters as much as the USING here — without it a broker could set brokerage_id to NULL and promote their own content into the catalogue every other tenant reads.',
      array_length(null_writers, 1), array_to_string(null_writers, ', ');
  end if;

  select coalesce(array_agg(p.polname || ' [' || p.polcmd::text || ']' order by p.polname), '{}')
  into   unstaffed
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'learning_modules'
    and  p.polpermissive and p.polcmd in ('a','w','d','*')
    and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
                coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
                'is_platform_staff()') = 0;

  if array_length(unstaffed, 1) is not null then
    raise exception
      'm422(3): % write polic(ies) on learning_modules do not gate on is_platform_staff(): %. The platform must be able to AUTHOR the training it supplies. is_platform_staff() is m408''s four-role helper (superadmin, admin, marketing, support); is_platform_admin() is deliberately NOT used, because it is one account on this database and a support or marketing staffer could not fix a typo in a platform course.',
      array_length(unstaffed, 1), array_to_string(unstaffed, ', ');
  end if;

  -- ── (4) THE ANON HALF ──────────────────────────────────────────────────────
  select coalesce(array_agg(c.relname || '.' || p.polname order by c.relname, p.polname), '{}')
  into   public_granted
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  c.relname in ('learning_modules','learning_assignments')
    and  (p.polroles = '{0}'::oid[]                                  -- PUBLIC
          or exists (select 1 from pg_roles r
                      where r.oid = any(p.polroles) and r.rolname = 'anon'));

  if array_length(public_granted, 1) is not null then
    raise exception
      'm422(4): % polic(ies) on the learning tables are granted to PUBLIC or anon: %. On learning_modules this is now an OPEN-INTERNET READ OF THE PLATFORM COURSE CATALOGUE. Before m421 the PUBLIC grant was harmless only by accident: the read rule was `brokerage_id = current_user_brokerage_id()`, which for an anonymous caller evaluates to `brokerage_id = NULL` -> NULL -> false. `brokerage_id IS NULL` does not mention the caller at all — it is true of the platform row for EVERYONE — so the exact widening the ruling asks for converts that dormant grant into anonymous access to every platform course body, quiz question and correct answer through the anon key with no account. Grant these policies to `authenticated`. The ruling says the platform''s training is for THE TENANTS; it never said it is public marketing content.',
      array_length(public_granted, 1), array_to_string(public_granted, ', ');
  end if;

  -- ── (5) the role gate survived ─────────────────────────────────────────────
  select coalesce(array_agg(p.polname || ' [' || p.polcmd::text || ']' order by p.polname), '{}')
  into   roleless_writes
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'learning_modules'
    and  p.polpermissive and p.polcmd in ('a','w','d','*')
    and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
                coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
                'current_user_type()') = 0;

  if array_length(roleless_writes, 1) is not null then
    raise exception
      'm422(5): % write polic(ies) on learning_modules carry no role test: %. Authoring a course is a broker/broker_admin/admin/superadmin/team_lead capability, and the tenant branch must keep testing current_user_type(). Reducing the rule to plain `is_platform_staff() OR brokerage_id = current_user_brokerage_id()` reads like the platform-catalogue pattern but silently hands every authenticated AGENT in every brokerage INSERT, UPDATE and DELETE on their brokerage''s courses. m406 preserved exactly this role test on training_videos for the same reason. (This asserts that a role test EXISTS, not which names are in it — the roster is a separate decision.)',
      array_length(roleless_writes, 1), array_to_string(roleless_writes, ', ');
  end if;

  -- ── (6) the boundary is pinned ─────────────────────────────────────────────
  select a.attnotnull into la_notnull
  from   pg_attribute a
  join   pg_class     c on c.oid = a.attrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'learning_assignments'
    and  a.attname = 'brokerage_id' and a.attnum > 0 and not a.attisdropped;

  if la_notnull is null or not la_notnull then
    raise exception
      'm422(6): learning_assignments.brokerage_id is nullable. A MODULE is content and may belong to the platform; an ASSIGNMENT is the record that a particular tenant''s agent was given that content, and it always belongs to that tenant. An untenanted assignment is a completion record and a quiz score owned by nobody. The FK to learning_modules(id) targets the id, not the tenant, so a tenant-owned assignment already points at a platform course — nothing here needed to move for the ruling to land.';
  end if;

  select count(*) into fk_n
  from   pg_constraint con
  join   pg_class src on src.oid = con.conrelid
  join   pg_class tgt on tgt.oid = con.confrelid
  join   pg_namespace n on n.oid = src.relnamespace
  where  n.nspname = 'public' and con.contype = 'f' and tgt.relname = 'learning_modules'
    and  src.relname in ('learning_assignments','learning_module_channel_publications');

  if fk_n < 2 then
    raise exception
      'm422(6): only % of the 2 foreign keys into learning_modules survive (learning_assignments.module_id, learning_module_channel_publications.module_id). Neither needed to change for a course to belong to the platform, which is precisely why a hand "completing the pattern" might drop one.',
      fk_n;
  end if;

  raise notice 'm422: PASS — learning_modules.brokerage_id is nullable so the platform can supply a course; % SELECT polic(ies) admit the platform row; every write policy gates on is_platform_staff(), carries a role test, and refuses the untenanted row; no policy on the learning tables is granted to PUBLIC or anon; learning_assignments stays tenant-owned and both FKs survive.',
    read_ok;
end $$;
