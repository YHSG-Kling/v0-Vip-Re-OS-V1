-- m177 — Wave 39: register the CMAReel composition.
--
-- Makes the chart-layer flagship (remotion/CMAReel.tsx) a first-class
-- registry citizen so it flows through the whole agentic loop: tier gate
-- (canAccessComposition) → cost estimate → Asset Manager start_render →
-- m172 render queue → companion VideoCoverThumb → GEO /v/[slug] page.
-- Available to every tier (lowest = solo_agent → all tiers inherit).

insert into public.remotion_compositions (
  composition_id, display_name, category, orientation, width, height,
  duration_frames, fps, requires_did_avatar, requires_voiceover, tier_access,
  is_active, seo_title, seo_description, thumbnail_composition_id,
  supports_bookends, stock_intro_category, stock_outro_category, asset_manager_notes
) values (
  'CMAReel',
  'Comparative Market Analysis Reel',
  'presentation', 'square', 1080, 1080,
  720, 30, false, false, array['solo_agent'],
  true,
  'Comparative Market Analysis — your home''s value in today''s market',
  'An animated CMA video: median price trend, comparable sales, days on market, and monthly affordability for the neighborhood — the data-driven CMA as a shareable, AI-search-citable video.',
  'VideoCoverThumb',
  true, 'brand_intro', 'logo_outro',
  'Chart-layer flagship. Charts are deterministic SVG (lib/charts/geometry); data arrives via inputProps from the caller''s RentCast/comps payload.'
)
on conflict (composition_id) do update set
  display_name      = excluded.display_name,
  category          = excluded.category,
  duration_frames   = excluded.duration_frames,
  seo_title         = excluded.seo_title,
  seo_description   = excluded.seo_description,
  thumbnail_composition_id = excluded.thumbnail_composition_id,
  supports_bookends = excluded.supports_bookends,
  is_active         = true;
