-- m119 — widen ai_video_projects.video_type to include 'presentation_chapter'.
-- Closes the consolidation loop with m118 so chapter videos land in the same
-- brand-overlay + intro/outro pipeline the poll-did-videos cron drives.

alter table public.ai_video_projects
  drop constraint if exists ai_video_projects_video_type_check;

alter table public.ai_video_projects
  add constraint ai_video_projects_video_type_check
  check (video_type = any (array[
    'listing_tour','pre_appointment','coming_soon','just_listed','open_house_promo',
    'just_sold','agent_intro','market_update','education','social_reel',
    'listing_promo','testimonial','welcome',
    'presentation_chapter'
  ]));
