-- m274 — TEAMMATE VIDEO lane (avatar explainer).
--
-- 1. ai_video_projects.video_type gains 'avatar_explainer' — the teammate
--    explainer commission (lib/video/avatar-explainer.ts) stages rows with
--    this type onto the EXISTING Director rail (remotion_pending →
--    director-reel-render → poll-did-videos → composition-render-queue →
--    approval_status='pending_review' unified queue). Until this migration is
--    applied the commission degrades honestly to video_type='education' with
--    video_metadata.video_type_intent='avatar_explainer'.
--
-- 2. Register the TeammateExplainerReel composition (remotion/
--    TeammateExplainerReel.tsx): full-frame D-ID avatar clip wrapped in the
--    tenant brand kit (intro card, lower-third, watermark, outro CTA + QR).
--    supports_bookends=false — the composition carries its OWN brand frames,
--    so the coordinator's stock intro/outro pass must not double-frame it.
--    Lowest tier 'solo_agent' → every paying tier inherits access.

alter table public.ai_video_projects
  drop constraint if exists ai_video_projects_video_type_check;
alter table public.ai_video_projects
  add constraint ai_video_projects_video_type_check
  check (video_type = any (array[
    'listing_tour','pre_appointment','coming_soon','just_listed','open_house_promo',
    'just_sold','agent_intro','market_update','education','social_reel','listing_promo',
    'testimonial','welcome','presentation_chapter','memory_video','avatar_explainer'
  ]));

insert into public.remotion_compositions (
  composition_id, display_name, category, orientation, width, height,
  duration_frames, fps, requires_did_avatar, requires_voiceover, tier_access,
  is_active, seo_title, seo_description, thumbnail_composition_id,
  supports_bookends, stock_intro_category, stock_outro_category, asset_manager_notes
) values (
  'TeammateExplainerReel',
  'Teammate Explainer (Avatar + Brand Frames)',
  'explainer', 'square', 1080, 1080,
  900, 30, true, false, array['solo_agent'],
  true,
  'Your agent explains — quick real estate explainer',
  'A 30-second explainer narrated on camera by the agent''s AI teammate avatar, framed with the brokerage''s brand kit: intro card, lower-third, and CTA outro.',
  'VideoCoverThumb',
  false, null, null,
  'Teammate-video lane flagship. Copy is AI-authored + compliance-gated at commission (lib/video/avatar-explainer); the avatar mp4 arrives via the D-ID → avatar-render-orchestrator handoff. Own brand frames — never apply stock bookends.'
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
