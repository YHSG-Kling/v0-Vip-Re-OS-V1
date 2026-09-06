-- m430 — asserts m429.
--
-- Separate file for the m393/m395/m397/m399/m403/m407/m409/m420/m422 reason: a
-- `raise` rolls back its own transaction, so asserting inside m429 would undo the
-- very ALTER TABLE and policy rewrites it was checking and leave `scripts`
-- exactly as open as before, with a red migration as the only difference.
--
-- IT ASSERTS THE CONSTRUCT, NOT THE SPELLING, IN NINE DIRECTIONS.
--
-- (1) THE STRUCTURAL PRECONDITION. scripts.brokerage_id must exist and be
--     NULLABLE. Nullable IS the platform row under the m406/m408/m421
--     convention; without the column, "an agent's script belongs to their
--     brokerage" is not merely unimplemented, it is unsayable.
--
-- (2) THE AUDIENCE COLUMN AND ITS VOCABULARY. scripts.visibility must exist, be
--     NOT NULL, and be constrained by a CHECK. Asserted as "a check constraint
--     on this table mentions visibility", not as the three-name array — the
--     roster is a product decision and may grow (a team scope is the obvious
--     next one); that it is CONSTRAINED at all is the invariant.
--
-- (3) THE ONE THAT WOULD HAVE SHIPPED A BREACH — TENANCY IS TIED TO VISIBILITY.
--     A CHECK must relate visibility to brokerage_id. This is what makes an
--     untenanted agent script UNREPRESENTABLE rather than merely unlikely.
--
--     Recurring defect (c): a policy clause
--     `(brokerage_id IS NULL) OR (brokerage_id = <caller's tenant>)` means a NULL
--     row satisfies it for EVERY tenant — an unstamped row is PUBLISHED, not
--     hidden. m429's SELECT policy carries that disjunct DELIBERATELY, because on
--     this table NULL means the platform catalogue. That is correct and clause
--     (4) requires it. It is only correct while NULL cannot arrive by accident.
--     Strip this CHECK and the exact feature the ruling asks for becomes the
--     mechanism that publishes one agent's private script to every brokerage on
--     the platform.
--
-- (4) READ ADMITS THE PLATFORM ROW. At least one permissive SELECT policy must
--     carry `brokerage_id IS NULL` (m407(2)/m422(2)'s half). The naive reading of
--     the tenant-escape waves is "strip brokerage_id IS NULL everywhere", and
--     here that would leave the platform's scripts in the database and invisible
--     in the product — including to app/dashboard/voice/page.tsx's AI-call script
--     picker.
--
-- (5) READ IS NO LONGER UNCONDITIONAL. No permissive SELECT policy on scripts
--     may have `true` as its whole qualifier. That was the live rule
--     (scripts_select USING (true), TO authenticated) and it is the m417/m418
--     class one grant away from being the m392 class. It survived m417 only
--     because it is granted to `authenticated` — i.e. it was scored as "not an
--     ANONYMOUS leak" rather than as "not a leak". With zero rows it leaked
--     nothing; the ruling is what fills the table.
--
-- (6) WRITE DOES NOT ADMIT THE UNTENANTED ROW, AND CARRIES BOTH GATES. No
--     permissive INSERT/UPDATE/DELETE/ALL policy may carry `brokerage_id IS NULL`
--     (m407(1)/m422(3)'s half); every one must gate on a PLATFORM helper and must
--     carry the tenant predicate. The platform helper is matched as
--     is_platform_admin() OR is_platform_staff() — the construct "a platform
--     gate", not which of the two. m429 preserved the live is_platform_admin()
--     verbatim and said so; whether this catalogue joins m408's is_platform_staff
--     roster is a separate ruling, and this file must not prejudge it in either
--     direction.
--
-- (7) THE AUTHOR IS REAL ON BOTH SIDES. The SELECT policy must mention
--     auth.uid() (so "your own scripts" is reachable) and the INSERT WITH CHECK
--     must mention it too (so authorship cannot be forged). One without the other
--     is the failure that matters: an INSERT that does not pin created_by lets an
--     agent file a script under a colleague's name inside their own tenant, and
--     the read rule then serves it as that colleague's private work.
--
-- (8) THE MODERATION WRITE IS NOT INERT — recurring defect (e). Postgres
--     evaluates the SELECT policy to LOCATE the rows an UPDATE/DELETE names, so a
--     write policy admitting is_brokerage_admin() over rows the read policy hides
--     does nothing at all: the UPDATE matches zero rows and returns error: null,
--     which supabase-js reports as success. Stated as an implication rather than
--     a fixed predicate — IF a write policy admits brokerage admins, the read
--     policy must too — so it stays true if the moderation rule is later dropped
--     entirely.
--
-- (9) NO POLICY ON scripts IS GRANTED TO PUBLIC OR anon. Three of the four were
--     (polroles = {0}), and that leaked nothing only by accident: their platform
--     branch calls is_platform_admin(), false for anon, and their tenant branch
--     compares against current_user_brokerage_id(), NULL for anon. m422(4)
--     documents where that arrangement leads — a PUBLIC grant that is harmless
--     because the predicate happens to mention the caller becomes an open-internet
--     read the moment a clause that does NOT mention the caller
--     (`brokerage_id IS NULL`) is added. Clause (4) requires exactly such a
--     clause. Checked as polroles, not as text: the grant is invisible in the
--     policy expression, which is why it survived m394/m396/m404/m413/m417.
--
-- (10) THE TWO VOCABULARIES STAY SEPARATE, AND THE LINK EXISTS.
--      scripts.status keeps its own CHECK, distinct from visibility's — `status`
--      is the editorial lifecycle (draft|approved|archived, read by the voice
--      console as `status = 'approved'`) and `visibility` is the audience. And
--      ai_video_projects.source_script_id must exist as a foreign key INTO
--      scripts: it is the only link in the database from a live video to a
--      scripts row, and without it the second half of the ruling — "if the video
--      goes viral using that script" — has nothing to resolve. (The only other FK
--      that ever referenced scripts(id) is long_form_videos.script_id, on a table
--      with 0 rows, no writer and no reader.)
--
-- WHAT THIS DELIBERATELY DOES NOT ASSERT
--
--  * That any script EXISTS. scripts held 0 rows when m429 was written, because
--    the INSERT policy had refused its one writer since it was created. Asserting
--    a row count would assert seed data and would go red the moment a table was
--    truncated. This file asserts that the agent-authored row is now POSSIBLE and
--    SAFE.
--  * That a promotion has ever happened. video_performance_tracking holds 0 rows;
--    the OS has not rolled out.
--  * The application readers. `.eq("brokerage_id", id)` cannot see a platform row
--    (`NULL = <uuid>` is NULL, never true) and pg_policy cannot see TypeScript.
--    That is the guard chain's job, and is named here so the gap is deliberate.
--
-- NEGATIVE CONTROLS, WATCHED RED AGAINST THE LIVE DATABASE BEFORE m429 WAS
-- APPLIED. Each clause was run in isolation (running the whole body only ever
-- proves the FIRST failure, and the interesting question is whether every clause
-- can fail). A `raise` rolls back its own transaction, so none of this changed
-- anything; the schema was re-queried afterwards to confirm it:
--   · (1)  → RED: public.scripts.brokerage_id does not exist.
--   · (5)  → RED: "1 permissive SELECT polic(ies) on scripts read `true`:
--            scripts_select [r]".
--   · (6)  → RED: "3 write polic(ies) on scripts carry no tenant predicate:
--            scripts_del [d], scripts_ins [a], scripts_upd [w]".
--   · (9)  → RED: "3 polic(ies) on scripts are granted to PUBLIC or anon:
--            scripts_del [d], scripts_ins [a], scripts_upd [w]".
--   · (10) → RED: ai_video_projects has no foreign key into scripts.
--
-- POSITIVE CONTROL, in a transaction that applied m429's statements and was then
-- rolled back by a `raise`: all ten clauses green — brokerage_id nullable;
-- visibility NOT NULL with 2 CHECKs mentioning it, 1 of which also mentions
-- brokerage_id; 1 SELECT policy admitting the platform row and 0 reading `true`;
-- 0 write policies admitting the untenanted row, 0 without a platform gate, 0
-- without a tenant predicate; auth.uid() present on the read and on the INSERT
-- WITH CHECK; 2 write policies admit is_brokerage_admin() and 1 SELECT policy
-- does too; 0 policies granted to PUBLIC/anon; status keeps its own CHECK; 1 FK
-- ai_video_projects -> scripts.

do $$
declare
  brokerage_nullable   boolean;
  visibility_notnull   boolean;
  vocab_checks         int;
  tenancy_checks       int;
  status_checks        int;
  read_admits_platform int;
  unconditional_reads  text[];
  null_writers         text[];
  ungated_writes       text[];
  untenanted_writes    text[];
  select_has_author    int;
  insert_has_author    int;
  writes_admit_bkadmin int;
  read_admits_bkadmin  int;
  public_granted       text[];
  link_fks             int;
begin
  -- ── (1) the structural precondition ────────────────────────────────────────
  select not a.attnotnull into brokerage_nullable
  from   pg_attribute a
  join   pg_class     c on c.oid = a.attrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'scripts'
    and  a.attname = 'brokerage_id' and a.attnum > 0 and not a.attisdropped;

  if brokerage_nullable is null then
    raise exception
      'm430(1): public.scripts.brokerage_id does not exist, so an agent-authored script has no tenant and the ruling ("agent authored scripts should save to scripts ... shared to the whole brokerage") cannot be expressed at all. Every other member of the platform catalogue (onboarding_steps, training_videos, help_topics_kb, knowledge_articles, offer_strategy_templates, learning_modules) carries a nullable brokerage_id.';
  end if;
  if not brokerage_nullable then
    raise exception
      'm430(1): public.scripts.brokerage_id is NOT NULL, so a PLATFORM-supplied script is structurally impossible — the constraint refuses the row before any policy is consulted. This is the defect m421 found on learning_modules. NULL is the platform catalogue here, per m406/m408.';
  end if;

  -- ── (2) the audience column and its vocabulary ─────────────────────────────
  select a.attnotnull into visibility_notnull
  from   pg_attribute a
  join   pg_class     c on c.oid = a.attrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'scripts'
    and  a.attname = 'visibility' and a.attnum > 0 and not a.attisdropped;

  if visibility_notnull is null then
    raise exception
      'm430(2): public.scripts.visibility does not exist. The ruling has two states — author-private and brokerage-shared — and something has to hold them. It is deliberately NOT scripts.status: that column is the EDITORIAL lifecycle (draft|approved|archived) and app/dashboard/voice/page.tsx reads `status = ''approved''` to populate the AI-call script picker.';
  end if;
  if not visibility_notnull then
    raise exception
      'm430(2): public.scripts.visibility is nullable. A NULL audience is not a state anyone chose; every read predicate below would treat it as "not brokerage-shared" while the row sits there looking authored. The default is ''private'' and the column is NOT NULL so that a script''s audience is always a positive claim.';
  end if;

  select count(*) into vocab_checks
  from   pg_constraint con
  join   pg_class     c on c.oid = con.conrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'scripts' and con.contype = 'c'
    and  strpos(pg_get_constraintdef(con.oid), 'visibility') > 0;

  if vocab_checks = 0 then
    raise exception
      'm430(2): no CHECK constraint on public.scripts mentions `visibility`, so the audience is unconstrained free text. This repo constrains its status vocabularies at the database (scripts.status itself, ai_video_projects.status per m374, video_scripts_library.script_type) precisely because an unconstrained one drifts into spellings nothing reads. (This asserts a constraint EXISTS, not which names are in it — the roster is a product decision and a team scope is the obvious next one.)';
  end if;

  -- ── (3) tenancy is tied to visibility — the anti-publication invariant ─────
  select count(*) into tenancy_checks
  from   pg_constraint con
  join   pg_class     c on c.oid = con.conrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'scripts' and con.contype = 'c'
    and  strpos(pg_get_constraintdef(con.oid), 'visibility')   > 0
    and  strpos(pg_get_constraintdef(con.oid), 'brokerage_id') > 0;

  if tenancy_checks = 0 then
    raise exception
      'm430(3): no CHECK constraint on public.scripts relates `visibility` to `brokerage_id`, so an agent-authored script can carry a NULL brokerage_id. Clause (4) below REQUIRES the SELECT policy to admit `brokerage_id IS NULL`, because on this table NULL means the platform catalogue. That disjunct does not mention the caller — it is true for EVERY tenant (recurring defect (c): an unstamped row is PUBLISHED, not hidden). Without this CHECK the exact feature the owner asked for becomes the mechanism that publishes one agent''s private prospecting script to every brokerage on the platform. The constraint must make untenanted mean platform BY DEFINITION, so there is no third "unstamped" state for the disjunct to catch.';
  end if;

  -- ── (4) read admits the platform row ───────────────────────────────────────
  select count(*) into read_admits_platform
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'scripts'
    and  p.polpermissive and p.polcmd in ('r','*')
    and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), 'brokerage_id IS NULL') > 0;

  if read_admits_platform = 0 then
    raise exception
      'm430(4): no permissive SELECT policy on scripts admits `brokerage_id IS NULL`, so a platform-supplied script would exist in the database and be invisible to every tenant in the product — including to the AI-call script picker at app/dashboard/voice/page.tsx, which selects scripts with status = ''approved''. The read rule is m406''s: a tenant sees its own rows PLUS the platform''s.';
  end if;

  -- ── (5) read is no longer unconditional ────────────────────────────────────
  select coalesce(array_agg(p.polname || ' [' || p.polcmd::text || ']' order by p.polname), '{}')
  into   unconditional_reads
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'scripts'
    and  p.polpermissive and p.polcmd in ('r','*')
    and  coalesce(btrim(pg_get_expr(p.polqual, p.polrelid)), '') = 'true';

  if array_length(unconditional_reads, 1) is not null then
    raise exception
      'm430(5): % permissive SELECT polic(ies) on scripts read `true` — not "true for this tenant", `true`: %. Every script is then readable by every signed-in user of every brokerage on the platform. This was the live rule and it leaked nothing only because the table held ZERO rows (its INSERT policy had refused its one writer, app/actions/workflows.ts:generateScriptContent, since the policy was written). The owner''s ruling is what fills the table, so the ruling and this policy cannot both stand. It survived m417 because it is granted to `authenticated` rather than PUBLIC — scored as "not an ANONYMOUS leak" rather than as "not a leak".',
      array_length(unconditional_reads, 1), array_to_string(unconditional_reads, ', ');
  end if;

  -- ── (6) write refuses the untenanted row and carries both gates ────────────
  select coalesce(array_agg(p.polname || ' [' || p.polcmd::text || ']' order by p.polname), '{}')
  into   null_writers
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'scripts'
    and  p.polpermissive and p.polcmd in ('a','w','d','*')
    and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
                coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
                'brokerage_id IS NULL') > 0;

  if array_length(null_writers, 1) is not null then
    raise exception
      'm430(6): % write polic(ies) on scripts admit the untenanted platform row to an ordinary tenant: %. This is the hole m406 closed across the rest of the catalogue, where one agent at one brokerage could UPDATE and DELETE 100%% of the shared content. A write touching a NULL-tenant row must be gated on the platform; a tenant writes only rows carrying its OWN brokerage_id.',
      array_length(null_writers, 1), array_to_string(null_writers, ', ');
  end if;

  select coalesce(array_agg(p.polname || ' [' || p.polcmd::text || ']' order by p.polname), '{}')
  into   ungated_writes
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'scripts'
    and  p.polpermissive and p.polcmd in ('a','w','d','*')
    and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
                coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
                'is_platform_admin()') = 0
    and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
                coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
                'is_platform_staff()') = 0;

  if array_length(ungated_writes, 1) is not null then
    raise exception
      'm430(6): % write polic(ies) on scripts carry no PLATFORM gate: %. The platform catalogue (brokerage_id IS NULL) must stay platform-write-locked — giving a tenant write access to it hands one brokerage''s agent edit and delete over content every other tenant reads. Matched as is_platform_admin() OR is_platform_staff(): this asserts that A PLATFORM GATE EXISTS, not which of the two spells it. m429 preserved the live is_platform_admin() verbatim; whether this catalogue joins m408''s is_platform_staff roster is a separate ruling and this clause must not prejudge it.',
      array_length(ungated_writes, 1), array_to_string(ungated_writes, ', ');
  end if;

  select coalesce(array_agg(p.polname || ' [' || p.polcmd::text || ']' order by p.polname), '{}')
  into   untenanted_writes
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'scripts'
    and  p.polpermissive and p.polcmd in ('a','w','d','*')
    and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
                coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
                'current_user_brokerage_id()') = 0;

  if array_length(untenanted_writes, 1) is not null then
    raise exception
      'm430(6): % write polic(ies) on scripts carry no tenant predicate: %. Every write rule needs BOTH branches — the platform gate for the catalogue AND `brokerage_id = current_user_brokerage_id()` for the tenant — or the policy is either platform-only (which is the state that kept this table empty) or unscoped. On the UPDATE policy the WITH CHECK matters as much as the USING: without a tenant predicate on what the row may BECOME, a row can be MOVED to another brokerage or NULLed into the platform catalogue (recurring defect (f)).',
      array_length(untenanted_writes, 1), array_to_string(untenanted_writes, ', ');
  end if;

  -- ── (7) the author is real on both sides ───────────────────────────────────
  select count(*) into select_has_author
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'scripts'
    and  p.polpermissive and p.polcmd in ('r','*')
    and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), 'auth.uid()') > 0;

  if select_has_author = 0 then
    raise exception
      'm430(7): no permissive SELECT policy on scripts mentions auth.uid(), so "your own scripts" is not reachable. An agent-authored script starts PRIVATE — that is the whole point of the ruling''s promotion step — and a private script its own author cannot read is a write-only library. app/api/scripts/list/route.ts already reads this table as `created_by = auth.userId`; the policy must agree with it.';
  end if;

  select count(*) into insert_has_author
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'scripts'
    and  p.polpermissive and p.polcmd in ('a','*')
    and  strpos(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), 'auth.uid()') > 0;

  if insert_has_author = 0 then
    raise exception
      'm430(7): no permissive INSERT policy on scripts pins created_by to auth.uid(), so authorship can be forged. An agent could file a script under a colleague''s name inside their own tenant, and clause (7)''s read rule would then serve it as that colleague''s private work — and the viral promotion would later share it to the brokerage under the wrong author. The read half without the write half is worse than neither.';
  end if;

  -- ── (8) the moderation write is not inert — recurring defect (e) ───────────
  select count(*) into writes_admit_bkadmin
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'scripts'
    and  p.polpermissive and p.polcmd in ('a','w','d','*')
    and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
                coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
                'is_brokerage_admin()') > 0;

  select count(*) into read_admits_bkadmin
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'scripts'
    and  p.polpermissive and p.polcmd in ('r','*')
    and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), 'is_brokerage_admin()') > 0;

  if writes_admit_bkadmin > 0 and read_admits_bkadmin = 0 then
    raise exception
      'm430(8): % write polic(ies) on scripts admit is_brokerage_admin() but no SELECT policy does. Postgres evaluates the SELECT policy to LOCATE the rows an UPDATE or DELETE names, so that write rule is INERT: the admin cannot see their tenant''s private scripts, the UPDATE matches zero rows, and a zero-row UPDATE is `error: null` — which supabase-js hands back as success (recurring defects (a) and (e)). Widen the read and the write together, or neither. Stated as an implication so it stays true if brokerage-admin moderation is later dropped entirely.',
      writes_admit_bkadmin;
  end if;

  -- ── (9) no policy on scripts is granted to PUBLIC or anon ──────────────────
  select coalesce(array_agg(p.polname || ' [' || p.polcmd::text || ']' order by p.polname), '{}')
  into   public_granted
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'scripts'
    and  (p.polroles = '{0}'::oid[]
          or exists (select 1 from pg_roles r
                      where r.oid = any(p.polroles) and r.rolname = 'anon'));

  if array_length(public_granted, 1) is not null then
    raise exception
      'm430(9): % polic(ies) on scripts are granted to PUBLIC or anon: %. Three of the four were, and that leaked nothing only by ACCIDENT: their platform branch calls is_platform_admin() (false for anon) and their tenant branch compares against current_user_brokerage_id() (NULL for anon, so `brokerage_id = NULL` -> NULL -> false). Clause (4) requires a disjunct that does NOT mention the caller — `brokerage_id IS NULL` — and that is exactly the change that converts a dormant PUBLIC grant into an anonymous read, through the anon key shipped in the browser bundle, with no account. m422(4) documents the same trap on learning_modules. Grant these policies to `authenticated`. Checked as polroles, not as text: the grant is invisible in the policy expression, which is why it survived m394/m396/m404/m413/m417.',
      array_length(public_granted, 1), array_to_string(public_granted, ', ');
  end if;

  -- ── (10) the two vocabularies stay separate, and the link exists ───────────
  select count(*) into status_checks
  from   pg_constraint con
  join   pg_class     c on c.oid = con.conrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'scripts' and con.contype = 'c'
    and  strpos(pg_get_constraintdef(con.oid), 'status')     > 0
    and  strpos(pg_get_constraintdef(con.oid), 'visibility') = 0;

  if status_checks = 0 then
    raise exception
      'm430(10): public.scripts has no CHECK constraint that constrains `status` independently of `visibility`. These are two orthogonal questions — status is the EDITORIAL lifecycle (is this script finished) and visibility is the AUDIENCE (who may read it) — and merging them breaks the one live reader of this table''s status: app/dashboard/voice/page.tsx selects `status = ''approved''` for the AI-call script picker. m429 was required not to touch status; this is what holds it to that.';
  end if;

  select count(*) into link_fks
  from   pg_constraint con
  join   pg_class src on src.oid = con.conrelid
  join   pg_class tgt on tgt.oid = con.confrelid
  join   pg_namespace n on n.oid = src.relnamespace
  where  n.nspname = 'public' and con.contype = 'f'
    and  tgt.relname = 'scripts' and src.relname = 'ai_video_projects';

  if link_fks = 0 then
    raise exception
      'm430(10): ai_video_projects has no foreign key into scripts, so "if the video goes viral USING THAT SCRIPT" has nothing to resolve. Measured before m429: ai_video_projects carried script_content (text) and no script id of any kind; the `script_id` flowing through the video lane (app/actions/video-content.ts:143, app/api/ai/generate-video-script/route.ts:587) is a video_scripts_library id carried in an event payload with no column joining the tables; and the ONLY foreign key that has ever referenced scripts(id) is long_form_videos.script_id, on a table with 0 rows, no writer and no reader (services/supabaseService.ts:839-852). The link had to be created, and lib/video/viral-script-share.ts is the reader that stands on it.';
  end if;

  raise notice 'm430: PASS — scripts.brokerage_id is nullable so the platform can supply one; visibility is NOT NULL, constrained, and tied to tenancy by CHECK so an agent script can never be untenanted; % SELECT polic(ies) admit the platform row and none reads `true`; every write policy carries a platform gate AND a tenant predicate and refuses the untenanted row; the author is pinned on read and on insert; brokerage-admin moderation is reachable through the read policy; no policy is granted to PUBLIC or anon; status keeps its own vocabulary; and ai_video_projects carries the FK the viral rule resolves.',
    read_admits_platform;
end $$;
