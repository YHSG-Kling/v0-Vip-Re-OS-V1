-- m429 — AGENT-AUTHORED SCRIPTS GET A HOME, AND A VIRAL VIDEO PROMOTES ONE TO
--        THE WHOLE BROKERAGE.
--
-- THE OWNER'S RULING
--
--   "agent authored scripts should save to scripts and if it the video goes
--    viral using that script, it should be shared to the whole brokerage."
--
-- This closes a question the codebase has been deferring in a comment. See
-- app/actions/workflows.ts:generateScriptContent, which today ends with:
--
--     "Whether agent-authored scripts deserve their own author-scoped home is a
--      product decision, not something to settle from inside a catch block."
--
-- The owner has settled it. That comment is replaced by what was decided, in the
-- same change that makes the decision reachable.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE DEFECT, MEASURED AGAINST THE LIVE DATABASE, NOT REASONED ABOUT
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `public.scripts` is: id, title (NOT NULL), category, content (NOT NULL),
-- status (CHECK draft|approved|archived), created_by (uuid → users, NULLABLE),
-- created_at, updated_at. THERE IS NO brokerage_id. Verified against
-- pg_attribute, not against a types file.
--
-- Its four live policies (verified against pg_policy):
--
--   scripts_select  [r]  TO authenticated   USING (true)
--   scripts_ins     [a]  TO PUBLIC          WITH CHECK (is_platform_admin())
--   scripts_upd     [w]  TO PUBLIC          USING/CHECK (is_platform_admin())
--   scripts_del     [d]  TO PUBLIC          USING (is_platform_admin())
--
-- Two independent failures, and they point in opposite directions:
--
--  (1) THE READ IS `true`. Not "true for this tenant" — `true`. Every row in
--      `scripts` is readable by every signed-in user of every brokerage on the
--      platform. Today that leaks nothing because the table holds ZERO rows. The
--      moment the ruling lands and agents start authoring, it becomes a
--      cross-tenant read of their work: one agent's prospecting script, listing
--      pitch and objection handler, visible to every competing brokerage on the
--      OS. The ruling is that a viral script is shared with THE BROKERAGE — not
--      with the industry.
--
--  (2) THE WRITE IS PLATFORM-ADMIN-ONLY, WHICH IS WHY THE TABLE IS EMPTY.
--      `scripts_ins` has no per-author clause at all, so
--      app/actions/workflows.ts:521 — the one writer of this table — has been
--      REFUSED for every ordinary agent since the policy was written. That code
--      already destructures `error` and already reports the refusal honestly
--      (`{success: true, content, error: "…not saved…"}`), which is why this is a
--      known, documented dead end rather than a silent one. The zero row count is
--      the refusal, not an un-shipped feature.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT NULL brokerage_id MEANS HERE — AND WHY THAT IS SAFE ON THIS TABLE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- NULL means THE PLATFORM CATALOGUE. That is the established convention in this
-- codebase (m406/m408 for onboarding_steps, training_videos, help_topics_kb,
-- offer_strategy_templates, knowledge_articles; m421 for learning_modules), and
-- this file follows m421's shape rather than inventing a flag: nullable tenant
-- column, `brokerage_id IS NULL` in the SELECT policy, and NO write policy that
-- admits the untenanted row to a tenant.
--
-- The standing hazard with that convention — recurring defect (c) — is that
-- `(brokerage_id IS NULL) OR (brokerage_id = <caller's tenant>)` means an
-- UNSTAMPED row is PUBLISHED to every tenant, not hidden from them. On the
-- catalogue tables that disjunct is deliberate, because a platform row is
-- SUPPOSED to be read by everyone. The danger is an AGENT-authored row that
-- lands with a NULL tenant by accident: it would be published to the entire
-- platform through the very disjunct that makes the catalogue work.
--
-- This file makes that state UNREPRESENTABLE rather than merely discouraged, in
-- three layers, because one layer has not been enough anywhere else in this
-- workstream:
--
--   · A TABLE CHECK: (visibility = 'platform') = (brokerage_id IS NULL). An
--     untenanted row is a platform row BY DEFINITION — there is no third state
--     called "unstamped". A tenant row that tries to NULL its brokerage_id fails
--     the constraint before RLS is consulted, and an insert that simply FORGETS
--     the tenant fails too (the column default for visibility is 'private', and
--     'private' with a NULL tenant violates the CHECK). Fail-closed by
--     construction.
--   · THE INSERT WITH CHECK: the tenant branch requires
--     `brokerage_id IS NOT NULL AND brokerage_id = current_user_brokerage_id()`,
--     so a non-platform author cannot create an untenanted script even if the
--     CHECK above were later relaxed.
--   · THE UPDATE WITH CHECK: same clause, so a row cannot be MOVED into the
--     catalogue (or into another tenant) after the fact — recurring defect (f).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE VISIBILITY VOCABULARY, AND WHY IT IS NOT `status`
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `scripts.status` already exists and is already constrained to
-- draft|approved|archived. That is an EDITORIAL lifecycle — is this script
-- finished — and app/dashboard/voice/page.tsx:104 reads `status = 'approved'` to
-- populate the AI-call script picker. Overloading it with an audience would
-- break that reader and conflate two orthogonal questions.
--
-- So visibility is its own column with its own CHECK:
--
--   'private'   — the author's own. The state every agent-authored script starts
--                 in. Readable by its author (and by their brokerage's admins,
--                 see below); invisible to their colleagues.
--   'brokerage' — shared with the whole brokerage. This is the state the ruling
--                 promotes a viral script into.
--   'platform'  — the platform catalogue. Tied to brokerage_id IS NULL by the
--                 CHECK above; only is_platform_admin() may write one.
--
-- PROMOTION IS A ONE-COLUMN UPDATE: `SET visibility = 'brokerage'`. brokerage_id
-- does not move (it was already the author's tenant and must stay there), the
-- content does not move, no row is copied. That matters because the promotion
-- has to be IDEMPOTENT — a video crossing the threshold twice must not
-- double-anything — and the cheapest honest idempotency is a conditional update
-- on the single column that changes:
--   UPDATE scripts SET visibility='brokerage' WHERE id=$1 AND visibility='private'
-- which affects one row the first time and zero rows every time after.
-- lib/video/viral-script-share.ts does exactly that and checks the returned row
-- count, because a zero-row UPDATE is `error: null` in supabase-js — recurring
-- defect (a).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE SELECT POLICY ADMITS BROKERAGE ADMINS OVER PRIVATE SCRIPTS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Recurring defect (e): Postgres evaluates the SELECT policy to LOCATE the rows
-- an UPDATE or DELETE names. The write policies below let a brokerage admin
-- moderate their tenant's scripts (a brokerage must be able to retire an
-- off-brand or non-compliant script authored inside it). If SELECT admitted only
-- `created_by = auth.uid()`, that write policy would be inert — the admin could
-- not see the row to act on it, and the UPDATE would silently affect zero rows
-- while returning error: null. The read and the write are widened together, or
-- neither is.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ─────────────────────────────────────────────────────────────────────────────
--
--  * It does NOT widen the platform branch from is_platform_admin() to
--    is_platform_staff(). m408 made that move for the five catalogue tables it
--    named; `scripts` was not among them, and the ruling says nothing about who
--    on the platform maintains this catalogue. The live gate is preserved
--    verbatim and the widening — if it is wanted — is a separate decision with
--    its own ruling. m430 asserts a PLATFORM gate exists, as a construct, not
--    which of the two helpers spells it.
--
--  * It does NOT touch `scripts.status` or its CHECK. The voice console's
--    `status = 'approved'` filter keeps working unchanged.
--
--  * It does NOT backfill. There are 0 rows.
--
--  * It does NOT touch `video_scripts_library`. That is a DIFFERENT table and
--    the confusion between the two is worth naming: the video lane's
--    `script_id` (app/actions/video-content.ts:143,
--    app/api/ai/generate-video-script/route.ts:587) references
--    video_scripts_library(id), NOT scripts(id) — verified against
--    pg_constraint. The only foreign key that has ever pointed at scripts(id) is
--    long_form_videos.script_id, and long_form_videos is documented dead schema
--    (scripts/child-tenant-scope-simulator.ts:77 — "0 rows, no writer, and its
--    only reader was deleted"). So the ruling's "the video ... using that script"
--    had NO link to stand on, which is why section 5 below creates one.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE TENANT. Nullable = the platform catalogue, per m406/m408/m421.
--    ON DELETE CASCADE matches learning_modules and knowledge_articles: a
--    brokerage's scripts die with the brokerage; the platform's (NULL) are
--    untouched by any tenant's deletion.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.scripts
  add column if not exists brokerage_id uuid references public.brokerages(id) on delete cascade;

create index if not exists scripts_brokerage_id_idx on public.scripts (brokerage_id);

-- created_by is in every read predicate below and had no index (only the FK
-- constraint, which does not create one in Postgres).
create index if not exists scripts_created_by_idx on public.scripts (created_by);

comment on column public.scripts.brokerage_id is
  'Owning tenant, or NULL for a PLATFORM script supplied by the platform and readable by every signed-in tenant (the m406/m408/m421 platform-catalogue convention). NULL is not "unknown" and not "unstamped" — the scripts_visibility_matches_tenancy check makes NULL mean exactly visibility=''platform''. An agent-authored script can never carry NULL: the CHECK refuses it and the INSERT WITH CHECK refuses it again. Readers wanting the catalogue MUST use `.or("brokerage_id.eq.<id>,brokerage_id.is.null")`, never `.eq("brokerage_id", id)` — `NULL = <uuid>` is NULL and never true.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE AUDIENCE. Its own column and its own vocabulary — `status` is the
--    editorial lifecycle (draft|approved|archived) and stays that.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.scripts
  add column if not exists visibility text not null default 'private';

alter table public.scripts
  drop constraint if exists scripts_visibility_check;
alter table public.scripts
  add constraint scripts_visibility_check
  check (visibility = any (array['private'::text, 'brokerage'::text, 'platform'::text]));

-- The load-bearing one. An untenanted script IS a platform script, and a
-- tenanted script is NEVER a platform script. There is no "unstamped" state for
-- the SELECT policy's `brokerage_id IS NULL` disjunct to publish by accident.
alter table public.scripts
  drop constraint if exists scripts_visibility_matches_tenancy;
alter table public.scripts
  add constraint scripts_visibility_matches_tenancy
  check ((visibility = 'platform') = (brokerage_id is null));

comment on column public.scripts.visibility is
  'WHO may read this script, as distinct from `status`, which is WHETHER it is finished. private = the author only (plus their brokerage''s admins, who must be able to moderate what is authored inside their tenant); brokerage = every agent in the owning brokerage — the state the owner''s viral rule promotes a script INTO; platform = the platform catalogue, which the scripts_visibility_matches_tenancy CHECK ties to brokerage_id IS NULL. Promotion is deliberately a ONE-COLUMN update so it can be made idempotent as a conditional UPDATE ... WHERE visibility = ''private''.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. READ. The platform catalogue + your own + what your brokerage shared +
--    (for a brokerage admin) everything authored inside their tenant.
--
--    `USING (true)` is replaced, not amended. It is the m417/m418 class — a read
--    rule that mentions neither the caller nor the tenant — and it survived that
--    wave only because it is granted to `authenticated` rather than PUBLIC, i.e.
--    it was scored as "not an anonymous leak" rather than as "not a leak".
--
--    THE GRANT. This policy is already TO authenticated and the other three are
--    TO PUBLIC. All four are stated TO authenticated below, in the same
--    statements that widen them, for m421's reason: `brokerage_id IS NULL` does
--    not mention the caller, so it is true of a platform row for an anonymous
--    caller too. The write policies gain no anon reach today (their platform
--    branch calls is_platform_admin(), which is false for anon, and their tenant
--    branch compares against current_user_brokerage_id(), which is NULL for
--    anon) — but a PUBLIC grant that is harmless only because the predicate
--    happens to mention the caller is exactly the arrangement m421/m422 found
--    one widening away from an open-internet read.
-- ─────────────────────────────────────────────────────────────────────────────
alter policy scripts_select on public.scripts
  to authenticated
  using (
    brokerage_id is null
    or created_by = auth.uid()
    or (brokerage_id = public.current_user_brokerage_id()
        and (visibility = 'brokerage' or public.is_brokerage_admin()))
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. WRITE. An ordinary authenticated agent may create their OWN script in
--    their OWN brokerage. The platform catalogue stays platform-write-locked.
--
--    `created_by = auth.uid()` is part of the INSERT rule, not decoration: it is
--    what makes "your own scripts" in the read rule mean something. Without it
--    an agent could file a script under a colleague's name inside their own
--    tenant and it would be readable as that colleague's private work.
--
--    The tenant branch of every write clause carries `brokerage_id IS NOT NULL`
--    explicitly even though the scripts_visibility_matches_tenancy CHECK already
--    implies it. Recurring defect (f): the WITH CHECK governs what the row may
--    BECOME, and this is the clause that refuses "promote my own script into the
--    catalogue every other tenant reads". It should not depend on a constraint
--    in a different section of this file staying where it is.
--
--    scripts_ins/upd/del are DROPPED and recreated; scripts_select is ALTERed in
--    place. ALTER POLICY would have served all four (it takes TO and USING and
--    WITH CHECK in one statement, which is exactly what the SELECT rewrite above
--    does) — the three write rules are recreated only so they read as one block
--    instead of three ALTERs whose relationship a reader has to reconstruct.
--    Nothing here depends on the difference.
--
--    The audience clause is spelled `visibility <> 'platform'` rather than
--    `visibility = ANY (ARRAY['private','brokerage'])`. Two reasons, and the
--    second is not cosmetic: the negative form says what the rule MEANS (a
--    tenant may not write a catalogue row) and does not have to be revisited if
--    the vocabulary grows a fourth value like 'team'; and
--    scripts/vocabulary-snapshot-guard.ts parses migrations for
--    `<col> = ANY (ARRAY[…])` to learn a column's CHECK vocabulary, so an
--    ARRAY-shaped policy predicate in this file is read as a competing
--    declaration of scripts.visibility and reports a snapshot disagreement that
--    is not real. Watched red before this line was written.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists scripts_ins on public.scripts;
create policy scripts_ins on public.scripts
  for insert to authenticated
  with check (
    public.is_platform_admin()
    or (brokerage_id is not null
        and brokerage_id = public.current_user_brokerage_id()
        and created_by = auth.uid()
        and visibility <> 'platform')
  );

drop policy if exists scripts_upd on public.scripts;
create policy scripts_upd on public.scripts
  for update to authenticated
  using (
    public.is_platform_admin()
    or (brokerage_id = public.current_user_brokerage_id()
        and (created_by = auth.uid() or public.is_brokerage_admin()))
  )
  with check (
    public.is_platform_admin()
    or (brokerage_id is not null
        and brokerage_id = public.current_user_brokerage_id()
        and (created_by = auth.uid() or public.is_brokerage_admin())
        and visibility <> 'platform')
  );

drop policy if exists scripts_del on public.scripts;
create policy scripts_del on public.scripts
  for delete to authenticated
  using (
    public.is_platform_admin()
    or (brokerage_id = public.current_user_brokerage_id()
        and (created_by = auth.uid() or public.is_brokerage_admin()))
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. THE LINK THE RULING NEEDS AND THE SCHEMA DID NOT HAVE.
--
--    "if the video goes viral USING THAT SCRIPT" requires a video to know which
--    scripts(id) it was rendered from. Measured, not assumed:
--
--      · ai_video_projects — the live video rail — has script_content (text) and
--        no script id of any kind.
--      · The `script_id` that flows through the video lane
--        (app/actions/video-content.ts:143 → approveAndGenerateVideo, and
--        app/api/ai/generate-video-script/route.ts:587) is a
--        video_scripts_library id. It is carried in an event payload; no column
--        joins the two tables either.
--      · long_form_videos.script_id is the ONLY foreign key in the database that
--        references scripts(id), and long_form_videos is dead schema: 0 rows, no
--        writer, its only reader deleted (services/supabaseService.ts:839-852).
--
--    So the link is created here, as a real foreign key on the rail that
--    actually carries engagement, with ON DELETE SET NULL to match the other
--    optional provenance FK on this table (marketing_campaign_id). Its producer
--    is app/actions/video/create-video-project.ts:createVideoProject, which
--    resolves and tenant-checks the script before stamping it — the same shape
--    that function already uses for campaignId.
--
--    The promotion reader NEVER trusts this column's tenancy on its own: it
--    resolves the project's brokerage_id AND the script's brokerage_id and
--    refuses a mismatch, because a foreign key proves the script exists, never
--    that it is ours (the lesson createVideoProject already records about
--    marketing_campaign_id).
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.ai_video_projects
  add column if not exists source_script_id uuid references public.scripts(id) on delete set null;

create index if not exists ai_video_projects_source_script_id_idx
  on public.ai_video_projects (source_script_id);

comment on column public.ai_video_projects.source_script_id is
  'The public.scripts row this video was rendered from, when the agent rendered a saved script rather than pasting raw text. This is the link the owner''s viral rule stands on: when the project''s video_performance_tracking.total_views crosses VIRAL_VIEW_THRESHOLD (app/types/video-generation.ts), lib/video/viral-script-share.ts flips that script''s visibility from private to brokerage. It is NOT a tenancy claim: the promoter re-resolves BOTH this project''s brokerage_id and the script''s brokerage_id and refuses to promote across a mismatch. Distinct from video_scripts_library, which is the video lane''s own script table and is referenced by marketing_campaigns.source_script_id.';
