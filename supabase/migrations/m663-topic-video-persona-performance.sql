-- ── APPLIED LIVE 2026-09-26 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
--
-- m663 — per-persona learning for autonomous TOPIC VIDEOS (wave 83, lane 83F).
--
-- Topic videos log their claim as content_topic_uses.asset_type = 'situational_reel'
-- (lib/video/topic-video-runner.ts → logTopicUses), and pickTopics reads
-- content_asset_persona_performance for (persona, asset_type = 'situational_reel').
-- The asset_type CHECK on content_asset_persona_performance did NOT admit
-- 'situational_reel', so the aggregator's topic-video pass
-- (lib/content-intel/performance-aggregator.ts aggregateTopicVideoPersonaPerformance)
-- would be refused on every write and the pick would never learn.
--
-- Live constraint read 2026-09-26 (pg_constraint, project hrvaqgvukzxfskkcrwbt):
--   content_topic_persona_performance_asset_type_check
--   CHECK (asset_type = ANY (ARRAY['newsletter_campaign','newsletter_video',
--     'listing_promo','podcast_episode','social_post','blog_post','direct_mail',
--     'landing_page','marketing_plan_item']))
-- (The constraint keeps its pre-rename name from m136; the table was renamed later.)
--
-- Widened: drop + re-add with the FULL live list plus 'situational_reel'. Nothing is
-- removed. After applying, regenerate scripts/check-vocabularies.ts (CLAUDE.md §3).

begin;

alter table public.content_asset_persona_performance
  drop constraint if exists content_topic_persona_performance_asset_type_check;

alter table public.content_asset_persona_performance
  add constraint content_topic_persona_performance_asset_type_check
  check (asset_type in (
    'newsletter_campaign',
    'newsletter_video',
    'listing_promo',
    'podcast_episode',
    'social_post',
    'blog_post',
    'direct_mail',
    'landing_page',
    'marketing_plan_item',
    'situational_reel'
  ));

-- Postcondition: the widened CHECK exists, admits situational_reel, and still admits
-- every value it admitted before (nothing narrowed).
do $$
declare
  def text;
  v text;
begin
  select pg_get_constraintdef(c.oid) into def
    from pg_constraint c
   where c.conrelid = 'public.content_asset_persona_performance'::regclass
     and c.conname = 'content_topic_persona_performance_asset_type_check';
  if def is null then
    raise exception 'm663 postcondition: asset_type CHECK missing after re-add';
  end if;
  foreach v in array array['newsletter_campaign','newsletter_video','listing_promo','podcast_episode',
                           'social_post','blog_post','direct_mail','landing_page','marketing_plan_item',
                           'situational_reel'] loop
    if position(quote_literal(v) in def) = 0 then
      raise exception 'm663 postcondition: asset_type CHECK does not admit %', v;
    end if;
  end loop;
end $$;

commit;
