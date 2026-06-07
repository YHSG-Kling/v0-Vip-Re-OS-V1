-- m176 — Wave 39 scope-vocabulary consolidation (per product owner).
--
-- Canonical scope ladder, one vocabulary everywhere:
--     agent → team → brokerage → multi_location → platform
--
-- Fixes the drift the m175 sweep surfaced + the owner's clarifications:
--   1. 'private' is not a real scope — it was legacy drift on the
--      visibility_scope tables. Migrate every 'private' row → 'agent'
--      (owner-scoped) and drop 'private' from the allowed set.
--   2. The ladder must reach multi_location + platform everywhere — a
--      platform-owned or multi-location-owned asset must be representable.
--      scope_type tables were capped at (agent|team|brokerage); widen them.
--   3. social_posts.platform must accept 'all' = "every connected platform"
--      (the publish cron fans it out). Was capped to the 8 named platforms.
--
-- Constraint names are resolved dynamically (some differ from the
-- <table>_<col>_check convention, e.g. brd_scope_type_check) so this is
-- robust to naming drift.

do $$
declare
  t      text;
  cname  text;
  ladder text := 'array[''agent'',''team'',''brokerage'',''multi_location'',''platform'']';
  vis_tables   text[] := array[
    'marketing_assets','blog_posts','marketing_campaigns','seo_keywords',
    'ad_campaigns','repurpose_pipelines'];
  scope_tables text[] := array[
    'video_assets','remotion_composition_renders','campaign_bundles','ad_retarget_presets',
    'blog_cadence_policy','direct_mail_presets','email_presets','facebook_custom_audiences',
    'lifecycle_promo_policy','podcast_episode_presets','portal_push_presets','sms_presets',
    'social_post_presets','voicedrop_presets','ai_identity_profiles','brokerage_required_documents'];
begin
  -- 1. visibility_scope: migrate 'private' → 'agent', then widen to the ladder.
  foreach t in array vis_tables loop
    execute format('update public.%I set visibility_scope = ''agent'' where visibility_scope = ''private''', t);
    for cname in
      select conname from pg_constraint
      where conrelid = format('public.%I', t)::regclass and contype = 'c'
        and pg_get_constraintdef(oid) like '%visibility_scope%'
    loop
      execute format('alter table public.%I drop constraint %I', t, cname);
    end loop;
    execute format(
      'alter table public.%I add constraint %I_visibility_scope_check check (visibility_scope = any (%s))',
      t, t, ladder);
  end loop;

  -- 2. scope_type: widen to the full ladder (additive — no data migration).
  foreach t in array scope_tables loop
    for cname in
      select conname from pg_constraint
      where conrelid = format('public.%I', t)::regclass and contype = 'c'
        and pg_get_constraintdef(oid) like '%scope_type%'
    loop
      execute format('alter table public.%I drop constraint %I', t, cname);
    end loop;
    execute format(
      'alter table public.%I add constraint %I_scope_type_check check (scope_type = any (%s))',
      t, t, ladder);
  end loop;

  -- 3. social_posts.platform: add 'all' (fan-out to every connected platform).
  for cname in
    select conname from pg_constraint
    where conrelid = 'public.social_posts'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%platform%'
  loop
    execute format('alter table public.social_posts drop constraint %I', cname);
  end loop;
  execute 'alter table public.social_posts add constraint social_posts_platform_check
    check (platform = any (array[''facebook'',''instagram'',''linkedin'',''twitter'',''tiktok'',
                                 ''youtube'',''pinterest'',''google_business'',''all'']))';
end $$;
