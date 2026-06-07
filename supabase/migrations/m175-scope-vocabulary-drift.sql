-- m175 — Wave 39 drift sweep: unify the scope vocabulary + add the real
-- memory_video type. Surfaced auditing the image-creation drift (m174).
--
-- DRIFT 1 — two scope vocabularies. video_assets.scope_type and the whole
-- subscription model use (agent | team | brokerage). But visibility_scope
-- on marketing_assets / blog_posts / marketing_campaigns / seo_keywords was
-- constrained to (private | team | brokerage). SIX code sites write
-- visibility_scope='agent' (the dominant vocabulary) → every one of those
-- inserts FAILED the CHECK. We consolidate by widening visibility_scope to
-- accept 'agent' alongside the legacy 'private' (non-destructive — existing
-- 'private' rows stay valid; read-side only ever filters 'brokerage').
--
-- DRIFT 2 — memory_video. ai_video_projects.video_type omitted 'memory_video'
-- even though it's read via .eq('video_type','memory_video'), lives in the
-- orchestrator's personalVideoTypes, and drives a portal persona module.
-- The recommendations route inserted it → failed. Add it.

do $$
declare tbl text;
begin
  foreach tbl in array array['marketing_assets','blog_posts','marketing_campaigns','seo_keywords']
  loop
    execute format('alter table public.%I drop constraint if exists %I_visibility_scope_check', tbl, tbl);
    execute format($f$alter table public.%I add constraint %I_visibility_scope_check
      check (visibility_scope = any (array['private','team','brokerage','agent']))$f$, tbl, tbl);
  end loop;
end $$;

alter table public.ai_video_projects
  drop constraint if exists ai_video_projects_video_type_check;
alter table public.ai_video_projects
  add constraint ai_video_projects_video_type_check
  check (video_type = any (array[
    'listing_tour','pre_appointment','coming_soon','just_listed','open_house_promo',
    'just_sold','agent_intro','market_update','education','social_reel','listing_promo',
    'testimonial','welcome','presentation_chapter','memory_video'
  ]));
