-- m136 — generalize (topic × persona) attribution into (topic × asset_type × persona).
--
-- Wave 22-25 built the newsletter side of the agentic loop end-to-end:
-- per-topic perf, per-persona perf, per-recipient routing, agent self-grading.
-- Now extending to listing-promo, podcast, direct mail, landing pages,
-- social, blog — the m134 table needs an asset_type axis so every channel
-- can attribute the same topic to different scores by medium.
--
-- A topic that lands hard with first_time_buyer in NEWSLETTER may bomb
-- with first_time_buyer in PODCAST format. The picker can then route the
-- same topic differently per medium AND per persona.
--
-- Migration strategy:
--   1. Rename the table content_topic_persona_performance →
--      content_asset_persona_performance to match the new semantics.
--   2. Add asset_type column with default 'newsletter_campaign' (matches
--      what every existing row was implicitly storing).
--   3. Replace the (topic_id, persona) unique constraint with
--      (topic_id, asset_type, persona).
--   4. Backfill is a no-op — all existing rows are newsletter_campaign.
--   5. Indexes get the asset_type prefix so per-medium queries are
--      single-probe.
--
-- The picker (lib/content-intel/topic-bank.ts) gets an optional assetType
-- parameter; existing callers default to 'newsletter_campaign' so behavior
-- is unchanged. New channels pass their own asset_type when wiring up.

-- Step 1: add the column (default keeps existing rows valid).
alter table public.content_topic_persona_performance
  add column if not exists asset_type text not null default 'newsletter_campaign'
    check (asset_type in (
      'newsletter_campaign',
      'newsletter_video',
      'listing_promo',
      'podcast_episode',
      'social_post',
      'blog_post',
      'direct_mail',
      'landing_page',
      'marketing_plan_item'
    ));

-- Step 2: replace the unique constraint to include asset_type.
-- Drop by inferred name (Postgres assigns content_topic_persona_performance_topic_id_persona_key).
do $$
declare
  cname text;
begin
  select conname into cname
  from pg_constraint
  where conrelid = 'public.content_topic_persona_performance'::regclass
    and contype = 'u';
  if cname is not null then
    execute format('alter table public.content_topic_persona_performance drop constraint %I', cname);
  end if;
end$$;

alter table public.content_topic_persona_performance
  add constraint content_topic_persona_performance_unique
  unique (topic_id, asset_type, persona);

-- Step 3: refresh indexes for the new key shape.
drop index if exists idx_content_topic_persona_perf_persona_score;
create index if not exists idx_content_asset_persona_perf_lookup
  on public.content_topic_persona_performance (asset_type, persona, performance_score desc);

-- Step 4: rename the table to its new generalized name. Old name remains
-- accessible via a backward-compat view so any external consumer that
-- already references content_topic_persona_performance doesn't break in
-- the transition window. The view is read-only; writers must use the new
-- name directly.
alter table public.content_topic_persona_performance
  rename to content_asset_persona_performance;

create or replace view public.content_topic_persona_performance as
  select * from public.content_asset_persona_performance;
