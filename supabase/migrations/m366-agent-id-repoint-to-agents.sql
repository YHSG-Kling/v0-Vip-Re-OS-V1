-- m366-agent-id-repoint-to-agents.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- `agent_id` NOW MEANS ONE THING.
--
-- 195 columns in this schema are named `agent_id`. 175 foreign-key agents(id)
-- and 20 foreign-keyed users(id). That split sat upstream of roughly fifty
-- defects found by audit: a filter that silently matched nothing, or a foreign
-- key that rejected a write whose error was then discarded. The name looked
-- like it meant one thing and meant two, and no amount of care at the call site
-- fixes a name that lies.
--
-- This migration re-points the 20 to agents(id). After it, passing a users id
-- into an `agent_id` column fails LOUDLY at the constraint instead of silently
-- writing a row that joins to nothing.
--
-- OWNER'S RULING that authorised it, verbatim:
--   "the agent and user ids should be handled by the import identy
--    component/function."
-- Which is exactly what the callers now do — every one of them resolves through
-- lib/kernel/agent-identity.ts (or the server-only resolver) instead of handing
-- over whichever id happened to be in scope.
--
-- WHY THE RE-POINT AND NOT A RENAME. An earlier pass proposed renaming these 20
-- to agent_user_id, on the evidence that 36 tables already used that name. The
-- owner corrected it: the project deliberately moved AWAY from agent_user_id,
-- and that decision is why the resolver exists at all. Crossing between a users
-- id and an agents id is a RESOLVE, never a third column name meaning a bit of
-- both. Frequency was evidence of age, not endorsement.
--
-- ═══ WHY IT IS SAFE TO DO THIS NOW, AND ONLY NOW ═══
--
-- Verified immediately before applying: ALL TWENTY TABLES HOLD ZERO ROWS.
--
--   select count(*) over all 20  ->  0 rows, 0 non-null agent_id
--
-- So there is NOTHING TO BACKFILL and nothing that can be corrupted by getting a
-- translation wrong. This is the cheapest this migration will ever be, and it
-- gets monotonically more expensive from the first production row onward — at
-- which point it needs a users->agents translation for live data, per tenant,
-- with a correctness argument for every row that has no agents record.
--
-- ═══ ORDER, WHICH IS THE WHOLE LESSON ═══
--
-- An earlier attempt applied this DDL and was REVERTED in the same session,
-- because 45 call sites were passing a users id and were CORRECT to do so while
-- the constraint pointed at users. Moving the constraint without them does not
-- fix 45 sites — it regresses 45 working paths into silent-wrong-id paths, which
-- is precisely the failure this sweep exists to prevent.
--
-- So: THE CALLERS WERE CONVERTED FIRST. All 45 now resolve through the identity
-- component, and scripts/agent-id-repoint-guard.ts reads 0 before this file is
-- applied. A migration that outruns its callers is indistinguishable, at
-- runtime, from the defect it was meant to cure.
--
-- ON DELETE CASCADE is preserved exactly as it was: deleting the agent record
-- removes its dependent rows, which is the same intent the users FK carried.

do $$
declare
  t text;
  con text;
  tables text[] := array[
    'agent_intro_videos', 'ai_video_projects', 'closing_disclosure_agreement',
    'conversation_logs', 'income_forecast_snapshots', 'lifetime_customer_npv_scores',
    'listing_health_interventions', 'listing_health_scores', 'listing_promo_videos',
    'newsletter_scheduled_sends', 'newsletter_video_renders', 'pattern_adoptions',
    'podcast_auto_runs', 'podcast_episodes', 'podcast_templates', 'property_preferences',
    'revenue_protection_snapshots', 'review_requests', 'studio_sessions',
    'transparency_updates'
  ];
  live_rows bigint;
begin
  foreach t in array tables loop
    -- REFUSE on any table that has gained rows since this was written. Without
    -- this the migration would silently orphan real data behind a constraint it
    -- cannot satisfy — the exact class of silent damage the re-point exists to
    -- end. If this fires, stop and write the users->agents backfill first.
    execute format('select count(*) from public.%I where agent_id is not null', t) into live_rows;
    if live_rows > 0 then
      raise exception
        'm366 refused: %.agent_id holds % row(s). This migration assumes an empty table because it does not translate users ids to agents ids. Write the backfill first.',
        t, live_rows;
    end if;

    -- Drop the users-class FK by its real name rather than a guessed one.
    select c.conname into con
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attname = 'agent_id'
     where c.conrelid = format('public.%I', t)::regclass
       and c.contype = 'f'
       and c.confrelid = 'public.users'::regclass
       and a.attnum = any (c.conkey)
     limit 1;

    if con is not null then
      execute format('alter table public.%I drop constraint %I', t, con);
    end if;

    -- Idempotent: skip if a prior run already added it.
    if not exists (
      select 1 from pg_constraint c
       where c.conrelid = format('public.%I', t)::regclass
         and c.contype = 'f'
         and c.confrelid = 'public.agents'::regclass
         and c.conname = format('%s_agent_id_fkey', t)
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (agent_id) references public.agents(id) on delete cascade',
        t, format('%s_agent_id_fkey', t));
    end if;
  end loop;
end $$;

-- ─── proof, in the migration itself ──────────────────────────────────────────
-- If any of the 20 still points at users after this runs, fail rather than
-- report success.
do $$
declare stragglers text;
begin
  select string_agg(c.conrelid::regclass::text, ', ')
    into stragglers
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attname = 'agent_id'
   where c.contype = 'f'
     and c.confrelid = 'public.users'::regclass
     and a.attnum = any (c.conkey)
     and c.conrelid::regclass::text = any (array[
       'agent_intro_videos', 'ai_video_projects', 'closing_disclosure_agreement',
       'conversation_logs', 'income_forecast_snapshots', 'lifetime_customer_npv_scores',
       'listing_health_interventions', 'listing_health_scores', 'listing_promo_videos',
       'newsletter_scheduled_sends', 'newsletter_video_renders', 'pattern_adoptions',
       'podcast_auto_runs', 'podcast_episodes', 'podcast_templates', 'property_preferences',
       'revenue_protection_snapshots', 'review_requests', 'studio_sessions',
       'transparency_updates']);

  if stragglers is not null then
    raise exception 'm366 incomplete: still users-class -> %', stragglers;
  end if;
end $$;
