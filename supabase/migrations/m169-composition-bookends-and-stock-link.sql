-- m169 — Wave 39 cleanup. Connect the Remotion composition registry
-- to the existing intro/outro/B-roll pipeline so the W40 render
-- coordinator knows which compositions are bookendable + can read
-- the brokerage's video_assets stock library directly.
--
-- Pre-existing surfaces this migration EXTENDS (does NOT duplicate):
--   · scripts/1087-ai-video-projects-intro-outro-broll.sql added
--     intro_video_url + outro_video_url + b_roll_urls to
--     ai_video_projects. The poll-did-videos cron concatenates
--     intro → main → outro via lib/video/composite-attribution
--     (concatIntroOutro helper). That helper stays the canonical
--     stitching path — Remotion render endpoints will call it
--     on their output buffers (W40 wiring).
--   · video_assets is the brokerage-curated stock library
--     (intro / outro / b_roll) the BrollPicker UI already reads.
--
-- New fields added to remotion_compositions:
--   supports_bookends    — videos true; static cards / postcards
--                          false. Used by the render coordinator to
--                          decide whether to attempt the concat.
--   stock_intro_category — when set, the renderer pulls a
--                          video_assets row where category=this
--                          and uses its video_url as the intro.
--   stock_outro_category — same for outro.
--
-- The category strings mirror video_assets.category values the
-- BrollPicker already exposes ("brand_intro", "logo_outro",
-- "neighborhood", etc.).

alter table public.remotion_compositions
  add column if not exists supports_bookends    boolean not null default false,
  add column if not exists stock_intro_category text,
  add column if not exists stock_outro_category text;

-- Backfill the bookend flag — every video category supports
-- bookends; static cards + postcards don't.
update public.remotion_compositions
   set supports_bookends = true
 where category in (
   'listing','explainer','presentation','market_update',
   'testimonial','open_house','coming_soon','neighborhood',
   'affordability','agent_avatar','newsletter'
 );

-- Set sensible default stock categories so the render coordinator
-- has a starting point. Brokerage admin can override per
-- composition via the admin UI (W40 wiring).
update public.remotion_compositions
   set stock_intro_category = 'brand_intro',
       stock_outro_category = 'logo_outro'
 where supports_bookends = true
   and stock_intro_category is null;

comment on column public.remotion_compositions.supports_bookends is
  'Wave 39: when true, the render coordinator wraps the composition output with intro + outro from video_assets via concatIntroOutro. Videos true; static cards + postcards false.';
comment on column public.remotion_compositions.stock_intro_category is
  'Wave 39: video_assets.category to pull for the intro. NULL means no intro even when supports_bookends=true.';
comment on column public.remotion_compositions.stock_outro_category is
  'Wave 39: video_assets.category to pull for the outro. NULL means no outro even when supports_bookends=true.';
