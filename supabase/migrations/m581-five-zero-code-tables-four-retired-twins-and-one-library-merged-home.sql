-- m581 — FIVE ZERO-CODE TABLES: FOUR RETIRED TWINS AND ONE LIBRARY MERGED HOME
--
-- APPLIED 2026-08-28 hrvaqgvukzxfskkcrwbt.
-- Written by lane E4; applied by the integrator (§3) after running every
-- EVIDENCE query below live: row counts 0,0,0,8,0; no triggers; no procs; the
-- one expected inbound FK (transparency_updates.transparency_video_id — the
-- constraint's short name transparency_updates_video_id_fkey names the same
-- column, verified via pg_constraint/conkey); live playbooks shape {content,
-- created_at, created_by, description, id, name, playbook_type, status,
-- updated_at} (name-col path). Post-apply: 0 of the 5 tables remain, 8 seed
-- rows merged into template_marketplace, both retired columns gone.
--
-- Lane CD's census (2026-08-28) reported these five tables ZERO-CODE — no
-- `.from("<table>")` call site on either side of the wire — and each of its
-- type tombstones in types.ts says the table "stays recorded on the
-- opposite-missing wire list for the table-retirement lane". This is that lane.
-- Lane E4 re-verified independently on COMMENT-STRIPPED source
-- (scripts/strip-comments.ts stripComments; blankStrings for the bare-token
-- pass so a quoted fixture cannot count, §2) across
-- app/lib/components/services/workflows/hooks/contexts/constants/remotion/
-- scripts/types + root files (5,443 files): 0 call sites for all five.
-- POSITIVE CONTROLS on the same run: contacts 1,376 call sites, listings 538;
-- a synthetic specimen of each shape (`.from("transparency_videos")`,
-- `.from('listing_engagement')`, `.from(\`long_form_videos\`)`, bare
-- `playbooks` and `notification_preferences` tokens) was seen by the finder.
-- The only non-generated mentions are hand-kept guard/registry lists (named in
-- the integrator footer) and generated schema caches.
--
-- ── EVIDENCE THE INTEGRATOR RUNS BEFORE APPLYING (read-only) ─────────────────
-- 1. Row counts — expected 0,0,0,≈8,0 (playbooks held 8 seed rows per the
--    L60-S02 investigation recorded at lib/kernel/manager-registry.ts:642; the
--    merge block below carries them; ANY unexpected rows elsewhere stop the
--    apply for re-adjudication — the in-file assertions also refuse):
--      SELECT 'transparency_videos', count(*) FROM public.transparency_videos
--      UNION ALL SELECT 'listing_engagement', count(*) FROM public.listing_engagement
--      UNION ALL SELECT 'long_form_videos', count(*) FROM public.long_form_videos
--      UNION ALL SELECT 'playbooks', count(*) FROM public.playbooks
--      UNION ALL SELECT 'notification_preferences', count(*) FROM public.notification_preferences;
-- 2. No trigger writer hides behind the zero (§3):
--      SELECT tgrelid::regclass, tgname FROM pg_trigger
--      WHERE NOT tgisinternal AND tgrelid::regclass::text IN
--        ('transparency_videos','listing_engagement','long_form_videos',
--         'playbooks','notification_preferences');
--    (playbooks may show update_playbooks_updated_at from scripts/030 — a
--     touch-updated_at trigger is not a writer of record; anything else stops
--     the apply.)
-- 3. No proc/.rpc()/backfill writer (§3):
--      SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--      WHERE n.nspname='public' AND (
--        prosrc ILIKE '%transparency_videos%' OR prosrc ILIKE '%listing_engagement%'
--        OR prosrc ILIKE '%long_form_videos%' OR prosrc ILIKE '%playbooks%'
--        OR prosrc ILIKE '%notification_preferences%');
--    Expected: none (a hit on live_schema_json/tenant_scope_facts-style
--    introspection helpers is reporting, not writing; anything else stops the apply).
-- 4. Inbound FKs — expected EXACTLY ONE, handled in §A below
--    (transparency_updates.transparency_video_id → transparency_videos, per the
--    generated scripts/schema-fk-map.ts:752). If template_marketplace still
--    carries the scripts/070-era source_playbook_id → playbooks FK (the LIVE
--    shape in scripts/schema-snapshot.ts:634 does NOT have that column), stop
--    and re-adjudicate — RESTRICT below will refuse it anyway:
--      SELECT conrelid::regclass AS src, conname, confrelid::regclass AS tgt
--      FROM pg_constraint WHERE contype='f' AND confrelid::regclass::text IN
--        ('transparency_videos','listing_engagement','long_form_videos',
--         'playbooks','notification_preferences');
-- 5. The live playbooks column list (the repo holds THREE disagreeing shapes:
--    scripts/030, scripts/140, and the live CHECK vocabulary
--    status∈{active,archived,draft} + created_by→users that neither file has —
--    the merge block below discovers columns at run time and REFUSES shapes it
--    cannot map):
--      SELECT column_name FROM information_schema.columns
--      WHERE table_schema='public' AND table_name='playbooks' ORDER BY 1;
--
-- ── RESTRICT, NOT CASCADE — same ruling as m519/m578 ─────────────────────────
-- CASCADE would silently drop any dependent this census missed; RESTRICT
-- refuses instead, which costs nothing when the evidence is right and stops the
-- migration cold when it is wrong.
--
-- NO EXPLICIT BEGIN/COMMIT: the migration runner wraps this file in a
-- transaction; a nested COMMIT would break the all-or-nothing (per m519).

-- ═════════════════════════════════════════════════════════════════════════════
-- A. transparency_videos → video_assets (the asset shape) + ai_video_projects
--    (the produced-video rail) + video_engagement_events (the watch ledger).
--
-- What it was for (scripts/020:248): a bare video record {video_url,
-- thumbnail_url, duration_seconds, title, description, created_at} to attach to
-- transparency updates — transparency_updates grew a transparency_video_id FK
-- for it (scripts/020:243) that NO code has ever written or read (0 mentions
-- outside generated caches). The capability is BUILT ANOTHER WAY, column by
-- column: video_assets carries video_url, thumbnail_url, duration_seconds,
-- title, description, created_at — every column this table has — PLUS the
-- tenancy (brokerage_id/agent_id/team_id/scope_type/scope_id) it never grew,
-- and per-contact watch telemetry lives in video_engagement_events
-- (video_asset_id, contact_id, event_type, watch_duration_seconds). Produced
-- stage-explainer video rides ai_video_projects (contact_id/listing_id/
-- usage_intent/video_type). The transparency lane itself is live and never
-- touched this table: transparency_updates has 25+ call sites
-- (app/actions/transaction-transparency.ts, the portal feed) and carries its
-- links in communication_links_json/metadata.
-- Prior findings this drop rests on: 0 rows / 0 writers / only reader (a
-- cross-tenant service-client select in services/supabaseService.ts) DELETED —
-- docs/WALKTHROUGH-AUDIT-LEDGER.md "The four anchorless tables were the wrong
-- question"; recorded as DEAD SCHEMA at scripts/child-tenant-scope-simulator.ts:92;
-- anon/PUBLIC access already off per m413/m414, the world-writable update
-- policy dropped by m425. Type tombstone: types.ts (`TransparencyVideo`, lane
-- CD 2026-08-28).

-- A1. The one inbound FK: a column no code ever wrote or read. Assert it is
--     all-NULL (a value would mean somebody DID attach a video and this
--     adjudication is wrong), then drop the column — RESTRICT on the table
--     drop would otherwise refuse over the constraint.
do $$
declare
  linked bigint;
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'transparency_updates'
               and column_name = 'transparency_video_id') then
    execute 'select count(*) from public.transparency_updates where transparency_video_id is not null'
      into linked;
    if linked > 0 then
      raise exception
        'm581 REFUSED: % transparency_updates rows reference transparency_videos — the zero-code verdict is wrong, re-adjudicate',
        linked;
    end if;
  end if;
end $$;

ALTER TABLE public.transparency_updates
  DROP COLUMN IF EXISTS transparency_video_id RESTRICT;

-- A2. The per-blueprint toggle for this never-built feature
--     (journey_blueprints.transparency_videos_enabled, scripts/020:186): zero
--     code references (verified on stripped source — its only mentions are the
--     generated schema-snapshot and its own CREATE). A flag that enables a
--     feature whose table is retiring reads as enforced while enforcing
--     nothing (§2), so it retires with the table.
ALTER TABLE public.journey_blueprints
  DROP COLUMN IF EXISTS transparency_videos_enabled RESTRICT;

do $$
declare c bigint;
begin
  if to_regclass('public.transparency_videos') is null then return; end if;
  execute 'select count(*) from public.transparency_videos' into c;
  if c > 0 then
    raise exception 'm581 REFUSED: transparency_videos holds % rows, expected 0 — re-adjudicate before dropping', c;
  end if;
end $$;

DROP TABLE IF EXISTS public.transparency_videos RESTRICT;

-- ═════════════════════════════════════════════════════════════════════════════
-- B. long_form_videos → ai_video_projects (the live production rail);
--    long-form→clips repurposing rides video_snippets.
--
-- What it was for (scripts/020:310): a long-form video production pipeline
-- {title, description, video_url, script_id→scripts, status
-- planning/recording/editing/published, created_at, published_at}. The
-- capability is BUILT ANOTHER WAY, column by column on ai_video_projects:
-- title→title, video_url→video_url, script provenance script_id→
-- source_script_id (the FK m429 §5 created on the rail that actually carries
-- engagement), status→status (+ is_published), published_at→published_at,
-- created_at→created_at, duration/thumbnail/compliance/approval/tenancy on top
-- — none of which this table ever grew. The repurposing scaffolding that named
-- it (`LongFormVideo`/`ShortClip` types) fell in lane CD's tranche with
-- app/actions/video-repurposing.ts over video_snippets named as survivor.
-- The video lane itself already ruled on this table: its own rebuild script
-- (scripts/050-enhance-video-content-studio.sql:92) DROPs it CASCADE and
-- recreates a singular `long_form_video` — and the live database has NEITHER
-- applied that drop NOR the singular table (absent from scripts/live-tables.ts),
-- so the plural survived only because 050 never ran. Same shape as m578's
-- credit_conversation_logs precedent. m429:319 records (verified against
-- pg_constraint then) that long_form_videos.script_id was the ONLY FK in the
-- database referencing scripts(id) — it dies with the table; scripts' live
-- provenance link is ai_video_projects.source_script_id.
-- Prior findings: 0 rows / 0 writers / only reader deleted
-- (docs/WALKTHROUGH-AUDIT-LEDGER.md, scripts/child-tenant-scope-simulator.ts:90);
-- anon off per m413/m414; world-writable update policy dropped by m425.
-- Type tombstone: types.ts (`LongFormVideo`, lane CD 2026-08-28).
do $$
declare c bigint;
begin
  if to_regclass('public.long_form_videos') is null then return; end if;
  execute 'select count(*) from public.long_form_videos' into c;
  if c > 0 then
    raise exception 'm581 REFUSED: long_form_videos holds % rows, expected 0 — re-adjudicate before dropping', c;
  end if;
end $$;

DROP TABLE IF EXISTS public.long_form_videos RESTRICT;

-- ═════════════════════════════════════════════════════════════════════════════
-- C. listing_engagement → the written engagement primitives, one per
--    engagement_type, plus buyer_behavior_log as the per-contact trail.
--
-- What it was for (scripts/020:372): {listing_id, contact_id, engagement_type
-- ∈ view/save/inquiry/showing, created_at} (+brokerage_id from migration 030).
-- The capability is BUILT ANOTHER WAY, engagement_type by engagement_type:
--   view    → property_views (contact_id, brokerage_id, view_count,
--             time_spent_seconds) and listing_page_analytics
--   save    → saved_properties (49 call sites)
--   inquiry → listing_inquiries
--   showing → showings / showing_requests (35 call sites)
-- and the generic per-contact signal trail is buyer_behavior_log {contact_id,
-- listing_id, signal_type ⊇ engagement_type, signal_value, brokerage_id,
-- created_at} — a strict superset of this table's shape. The composed reader
-- ALREADY EXISTS: services/supabaseService.ts:getListingEngagement (the
-- burn-down round-6 repoint recorded in that function) assembles exactly this
-- table's old feed shape from those primitives — the repo itself ruled the
-- table a writer-less legacy and re-pointed its one consumer years of waves
-- ago; only the schema half remained. Recorded per-contact at
-- lib/kernel/listing-archive.ts:221 (a hand-kept rule list, not a call site).
-- Type tombstone: types.ts (`ListingEngagement`, lane CD 2026-08-28).
do $$
declare c bigint;
begin
  if to_regclass('public.listing_engagement') is null then return; end if;
  execute 'select count(*) from public.listing_engagement' into c;
  if c > 0 then
    raise exception 'm581 REFUSED: listing_engagement holds % rows, expected 0 — merge them onto buyer_behavior_log (signal_type := engagement_type) before dropping', c;
  end if;
end $$;

DROP TABLE IF EXISTS public.listing_engagement RESTRICT;

-- ═════════════════════════════════════════════════════════════════════════════
-- D. playbooks → MERGE the seed library onto template_marketplace, THEN drop.
--    Survivors: plan_tasks (the installed, per-tenant playbook — columns
--    playbook_name/trigger_type/steps/target_persona_ids/active/usage_count;
--    live reader getPlaybooks and live writers createPlaybook
--    (app/actions/services-config.ts) + cloneTemplate (app/actions/academy.ts))
--    and template_marketplace (the deliberately cross-tenant library the clone
--    flow reads — "template_marketplace — clones playbooks → plan_tasks",
--    scripts/1042-collapse-parallel-education.sql:27).
--
-- History, in order, so the verdict is legible:
--  · L60-S02 (the legacy-dead-tables retirement) DELIBERATELY kept playbooks:
--    "unreferenced by code but holding 8 seed rows and an owner-requested
--    capability awaiting wiring" (lib/kernel/manager-registry.ts:642).
--  · The wiring then HAPPENED — onto plan_tasks, explicitly merged:
--    "plan_tasks is a MERGED table (copilot plan tasks + playbooks)"
--    (app/actions/services-config.ts createPlaybook), with template_marketplace
--    as the cross-tenant source tenants clone from. The playbooks table was
--    simply never the table the wiring landed on.
--  So under §1.1 this is a DUPLICATE with a survivor, and the survivor is
--  missing the 8 seed rows: merge them FIRST, as global marketplace templates
--  whose metadata carries exactly the keys cloneTemplate reads
--  (trigger_type/steps/target_persona_ids), then drop the duplicate.
--  Deleting without the merge would be deleting to move a number (§1).
--
-- The merge is DYNAMIC because the live shape is unknowable from the repo:
-- scripts/030 says {name, definition_json, …}, scripts/140 says
-- {playbook_name, steps, …}, and the LIVE table has a status CHECK
-- (active/archived/draft — scripts/check-vocabularies.ts:1165) plus
-- created_by→users (scripts/schema-fk-map.ts:580) that NEITHER file has. The
-- block below maps whichever columns exist, stashes the ENTIRE source row
-- losslessly in metadata.m581_source_row, and REFUSES (fail closed, §4) any
-- populated shape it cannot name — nothing is silently dropped.
do $$
declare
  n_rows    bigint;
  has       jsonb;
  name_col  text;
  steps_col text;
  ins       bigint;
begin
  if to_regclass('public.playbooks') is null then return; end if;
  execute 'select count(*) from public.playbooks' into n_rows;
  if n_rows = 0 then
    -- Seed content already gone (or merged by hand): nothing to carry.
    raise notice 'm581: playbooks is empty — no library rows to merge';
    return;
  end if;

  select coalesce(jsonb_object_agg(column_name, true), '{}'::jsonb) into has
  from information_schema.columns
  where table_schema = 'public' and table_name = 'playbooks';

  name_col  := case when has ? 'playbook_name' then 'playbook_name'
                    when has ? 'name'          then 'name' end;
  steps_col := case when has ? 'steps'           then 'steps'
                    when has ? 'definition_json' then 'definition_json' end;

  if name_col is null then
    raise exception
      'm581 REFUSED: playbooks holds % rows but has neither playbook_name nor name — unknown shape, adjudicate the merge by hand before dropping',
      n_rows;
  end if;

  execute format($f$
    insert into public.template_marketplace
      (template_name, template_body, template_type, visibility, usage_count,
       metadata, created_at%s)
    select
      p.%I,
      concat_ws(' — ', p.%I, %s),
      'playbook',
      'global',
      %s,
      jsonb_strip_nulls(jsonb_build_object(
        'trigger_type',       %s,
        'steps',              %s,
        'target_persona_ids', %s,
        'm581_source',        'playbooks seed library',
        'm581_source_row',    to_jsonb(p)
      )),
      %s
      %s
    from public.playbooks p
    where not exists (
      select 1 from public.template_marketplace t
      where t.template_type = 'playbook' and t.template_name = p.%I
    )
  $f$,
    case when has ? 'created_by' then ', author_user_id' else '' end,
    name_col,
    name_col,
    case when has ? 'purpose' then 'p.purpose' else 'NULL::text' end,
    case when has ? 'usage_count' then 'coalesce(p.usage_count, 0)' else '0' end,
    case when has ? 'trigger_type' then 'to_jsonb(p.trigger_type)' else 'NULL::jsonb' end,
    case when steps_col is not null then format('to_jsonb(p.%I)', steps_col) else 'NULL::jsonb' end,
    case when has ? 'target_persona_ids' then 'to_jsonb(p.target_persona_ids)' else 'NULL::jsonb' end,
    case when has ? 'created_at' then 'coalesce(p.created_at, now())' else 'now()' end,
    case when has ? 'created_by' then ', p.created_by' else '' end,
    name_col
  );
  get diagnostics ins = row_count;

  -- COUNT THE WRITE (§3): a merge that moved fewer rows than the source holds
  -- is a partial merge, and a partial merge followed by a drop is data loss.
  -- (Fewer inserted than n_rows with no error means the dedup WHERE skipped
  -- rows already present — acceptable only if the integrator confirms those
  -- marketplace rows are the same content; refuse by default.)
  if ins < n_rows then
    raise exception
      'm581 REFUSED: merged only % of % playbooks rows into template_marketplace (name collisions?) — reconcile before dropping',
      ins, n_rows;
  end if;
  raise notice 'm581: merged % playbooks seed rows into template_marketplace as global playbook templates', ins;
end $$;

DROP TABLE IF EXISTS public.playbooks RESTRICT;

-- ═════════════════════════════════════════════════════════════════════════════
-- E. notification_preferences (TABLE) → the notification-preference COLUMNS,
--    which are the side with every live reader, writer, and test.
--
-- A TABLE twin of a COLUMN pair. The table (user_id→users; per-user RLS from
-- migration 063:148-151) has had zero code on either side of the wire for its
-- whole life — its UI scaffolding (NotificationSettings.tsx and the
-- `NotificationPreference` type) is already deleted (types.ts tombstone, lane
-- CD 2026-08-28). The CAPABILITY — a person's notification choices, honored at
-- send time — is BUILT on columns, per audience:
--   · agents.notification_preferences jsonb — writer+reader
--     app/actions/settings/reputation-preferences.ts (act-as seam, counted
--     writes); backing column added by
--     scripts/add-agents-notification-preferences.sql after the column-less
--     save was found silently erroring.
--   · contacts.metadata.notification_preferences — writer
--     app/components/portal/PortalSettingsPage.tsx (updateContactProfile),
--     reader lib/notifications/buyer-preferences.ts, consulted on send paths
--     (lib/kernel/showing-lifecycle.ts:106) and enforced by
--     `npm run test:notification-preferences`.
--   · channel/event routing rides notification_rules + push subscriptions
--     (app/actions/push-subscriptions.ts), per the type tombstone.
-- The column side is canonical because it is the side that is READ where sends
-- happen; a second, row-per-user store nothing consults could only ever drift
-- from the one that is enforced (§6 — one vocabulary per function).
-- If rows exist (expected 0): merge each into agents.notification_preferences
-- for the agent whose agents.user_id matches (NEVER agents.id — the two id
-- spaces are disjoint, §3) before applying; the assertion refuses until then.
do $$
declare c bigint;
begin
  if to_regclass('public.notification_preferences') is null then return; end if;
  execute 'select count(*) from public.notification_preferences' into c;
  if c > 0 then
    raise exception 'm581 REFUSED: notification_preferences holds % rows, expected 0 — merge onto agents.notification_preferences via agents.user_id before dropping', c;
  end if;
end $$;

DROP TABLE IF EXISTS public.notification_preferences RESTRICT;

-- ── ASSERT THE DROPS LANDED (fail closed, §4) ────────────────────────────────
do $$
declare
  still_here text[];
  col_count  int;
begin
  select coalesce(array_agg(table_name order by table_name), '{}')
  into   still_here
  from   information_schema.tables
  where  table_schema = 'public'
    and  table_name in ('transparency_videos', 'listing_engagement',
                        'long_form_videos', 'playbooks',
                        'notification_preferences');
  if array_length(still_here, 1) is not null then
    raise exception 'm581: retired tables still present: %', still_here;
  end if;

  select count(*) into col_count
  from information_schema.columns
  where table_schema = 'public'
    and ((table_name = 'transparency_updates' and column_name = 'transparency_video_id')
      or (table_name = 'journey_blueprints'  and column_name = 'transparency_videos_enabled'));
  if col_count > 0 then
    raise exception 'm581: retired columns still present (% of 2 dropped)', 2 - col_count;
  end if;
end $$;

-- ── INTEGRATOR, after applying ───────────────────────────────────────────────
-- Regenerate ALL FOUR schema caches (§3 — each generator's header carries its
-- SQL): scripts/live-tables.ts (the five names leave; this is also what flips
-- them into test:legacy-tables-retired's derived RETIRED set, since that guard
-- computes RETIRED = shipped DROPs − LIVE_TABLES), scripts/schema-fk-map.ts
-- (drops the four FK entries and transparency_updates.transparency_video_id),
-- scripts/schema-snapshot.ts (transparency_updates and journey_blueprints lose
-- a column each; none of the five had a snapshot entry to lose), and
-- scripts/check-vocabularies.ts (three CHECKs leave with their tables:
-- listing_engagement.engagement_type, long_form_videos.status,
-- playbooks.status).
--
-- Then take the retired names out of the HAND-KEPT lists so none sits in a
-- list reading as enforced (§2), each with a tombstone naming this file:
--   · lib/kernel/manager-registry.ts:1788 (listing_engagement), :2025
--     (long_form_videos), :2026 (transparency_videos) — TABLE_MANAGER entries.
--     No playbooks/notification_preferences entries exist there.
--   · lib/kernel/manager-registry.ts:642 — the legacy_tables_retired prose
--     still says playbooks is "awaiting wiring"; record that m581 resolved it
--     (wiring landed on plan_tasks/template_marketplace; seeds merged here).
--   · lib/kernel/listing-archive.ts:221 (listing_engagement in
--     LISTING_CHILD_RULES) — and re-derive that file's "block (20)" count
--     comment (§2: assert the rule, derive the number).
--   · scripts/child-tenant-scope-simulator.ts:67 (playbooks), :90
--     (long_form_videos), :92 (transparency_videos) in ALLOWED.
--   · scripts/agent-fk-columns.ts:376 (listing_engagement).
--   · types.ts tombstones for TransparencyVideo/ListingEngagement/
--     LongFormVideo/NotificationPreference each end "…stays recorded on the
--     opposite-missing wire list for the table-retirement lane" — append that
--     m581 is that lane's verdict, so the pointer resolves.
-- Then run the full guard chain and read GUARD_EXIT (§7).
