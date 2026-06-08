-- m181 — Wave 39: register the ListingSectionReel composition.
-- One pre-listing presentation SECTION as a branded, narratable animated slide
-- (intro / credibility / marketing / process / closing). The CMA/market section
-- uses CMAReel; every other dripped section uses this. Avatar PIP + ElevenLabs
-- narration optional via the D-ID handoff (target_composition_id).
insert into public.remotion_compositions (
  composition_id, display_name, category, orientation, width, height,
  duration_frames, fps, requires_did_avatar, requires_voiceover, tier_access,
  is_active, seo_title, seo_description, thumbnail_composition_id,
  supports_bookends, stock_intro_category, stock_outro_category, asset_manager_notes
) values (
  'ListingSectionReel', 'Listing Presentation Section Reel',
  'presentation', 'horizontal', 1920, 1080, 300, 30, false, false, array['solo_agent'],
  true,
  'Listing presentation — why this brokerage, agent, and marketing system',
  'One section of the pre-listing presentation as a branded, narrated animated slide that sells the seller on the team before the appointment.',
  'VideoCoverThumb', true, 'brand_intro', 'logo_outro',
  'Renders a single pre-listing section; avatar PIP + ElevenLabs narration optional via the D-ID handoff. The CMA/market section uses CMAReel instead.'
)
on conflict (composition_id) do update set
  display_name=excluded.display_name, is_active=true;
