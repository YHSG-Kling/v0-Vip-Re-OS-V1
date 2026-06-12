-- m221 — register the PhotoWalkthroughReel composition.
--
-- The CINEMATIC photo→walkthrough reel (remotion/PhotoWalkthroughReel.tsx) —
-- turns any MLS photo set into a MOVING property tour so a listing with NO
-- walkthrough video still gets a scroll-stopping reel. Each photo gets a Ken
-- Burns pan/zoom over its own frame window with a cross-fade into the next,
-- plus narrated tour-beat captions. The motion is planned PURELY upstream by
-- lib/video/ken-burns-plan.ts (kenBurnsPlan(photos, bodyFrames, opts) →
-- per-photo clip windows that tile the body timeline, alternate pan
-- directions, cap an oversized set, and return [] honestly when there are no
-- photos). The composition renders that plan verbatim with interpolate
-- scale + translate (NO CSS transitions / Tailwind animation) and a cross-fade
-- between clips — fully deterministic, renders on the existing Chromium rail.
--
-- Photo source is the SAME one the render path already loads: listing_media
-- (file_url, sort_order asc, media_type='image'). It reuses the JustListedReel
-- brand / QR (QrOutroBadge) / voiceover (<Audio>) contract so it slots into
-- the existing render pipeline + bookends + music-mood.
--
-- Registering it makes PhotoWalkthroughReel a first-class registry citizen so
-- it flows through the whole agentic loop: tier gate (canAccessComposition) →
-- cost estimate → Asset Manager start_render → m172 render queue → companion
-- VideoCoverThumb (kind 'listing') → GEO /v/[slug] page. 1080×1080 square,
-- 20s (600 frames). requires_did_avatar=false + requires_voiceover=false: the
-- avatar/voiceover are OPTIONAL — the reel renders cleanly as a pure Remotion
-- moving photo tour when no narration is configured, and renders an HONEST
-- "photos coming soon" fallback card when the photo set is empty (no broken
-- render, no fabricated tour). Available to every tier (lowest = solo_agent →
-- all tiers inherit).

insert into public.remotion_compositions (
  composition_id, display_name, category, orientation, width, height,
  duration_frames, fps, requires_did_avatar, requires_voiceover, tier_access,
  is_active, seo_title, seo_description, thumbnail_composition_id,
  supports_bookends, stock_intro_category, stock_outro_category, asset_manager_notes
) values (
  'PhotoWalkthroughReel',
  'Photo Walkthrough Reel',
  'listing', 'square', 1080, 1080,
  600, 30, false, false, array['solo_agent'],
  true,
  'Take the tour — a moving walkthrough of this home from its photos',
  'A cinematic photo-to-walkthrough reel that turns a property''s listing photos into a moving tour: each room pans and zooms with narrated captions, so even a listing with no video gets a scroll-stopping walkthrough. Optional ElevenLabs voiceover and a tracked "scan to tour" QR.',
  'VideoCoverThumb',
  true, 'brand_intro', 'logo_outro',
  'Cinematic photo→walkthrough reel for listings with photos but no walkthrough video. Motion is the PURE kenBurnsPlan(photos, bodyFrames, opts) output (lib/video/ken-burns-plan.ts): per-photo Ken Burns windows that tile the body timeline, alternate pan directions, cap an oversized set to a watchable clip count, and return [] honestly when there are no photos — the Director then skips this format and the composition shows its "photos coming soon" fallback. Photos are listing_media (file_url, sort_order asc, media_type=image). Reuses the JustListedReel brand / QR / voiceover contract; voiceover + QR optional.'
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
