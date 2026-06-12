-- m220 — register the ExplainerAnimReel composition.
--
-- The ANIMATED EXPLAINER reel (remotion/ExplainerAnimReel.tsx) — the in-stack
-- answer to Manim. Where AgentExplainerReel narrates three bullets next to a
-- talking-head PIP, this composition ANIMATES a real-estate CONCEPT as a
-- deterministic diagram (equity-over-time draw-on curve / rate-buydown payment
-- bars / closing-timeline stepped path / what-$X/mo-buys price bars) with the
-- agent avatar PIP narrating. Manim needs Python+LaTeX+cairo and there is no
-- Python render service in the request path; this does what Manim does
-- (animated math/diagrams) NATIVELY in Remotion: the diagram CONTENT is pure
-- data (lib/charts/explainer-diagram.ts), the geometry reuses lib/charts/
-- geometry, and the animation is interpolate/spring/Sequence only — fully
-- deterministic, renders on the existing Chromium rail.
--
-- Registering it makes ExplainerAnimReel a first-class registry citizen so it
-- flows through the whole agentic loop: tier gate (canAccessComposition) → cost
-- estimate → Asset Manager start_render → m172 render queue → companion
-- VideoCoverThumb (kind 'explainer') → GEO /v/[slug] page. 1080×1080 square,
-- 18s (540 frames). requires_did_avatar=false: the avatar PIP is OPTIONAL — the
-- reel renders cleanly as a pure Remotion animated-diagram video when no avatar
-- is configured, and renders an HONEST "share your numbers" fallback when the
-- topic's facts are thin (no fabricated chart). Topic + facts ride on
-- situation.facts. Available to every tier (lowest = solo_agent → all inherit).

insert into public.remotion_compositions (
  composition_id, display_name, category, orientation, width, height,
  duration_frames, fps, requires_did_avatar, requires_voiceover, tier_access,
  is_active, seo_title, seo_description, thumbnail_composition_id,
  supports_bookends, stock_intro_category, stock_outro_category, asset_manager_notes
) values (
  'ExplainerAnimReel',
  'Animated Explainer Reel',
  'explainer', 'square', 1080, 1080,
  540, 30, false, false, array['solo_agent'],
  true,
  'Animated explainer — a real-estate concept as a moving diagram',
  'An animated explainer video that turns a real-estate concept into a moving diagram: how equity grows over time, what a rate buydown saves you, the escrow/closing timeline, or what a target monthly payment buys — with optional agent avatar narration. Deterministic, in-stack motion graphics (the native answer to Manim), every figure an estimate.',
  'VideoCoverThumb',
  true, 'brand_intro', 'logo_outro',
  'In-stack motion-graphics explainer (native answer to Manim — NO Python/manim runtime). Diagram CONTENT is the pure explainerDiagramSpec(topic, facts) output (lib/charts/explainer-diagram.ts); topic rides situation.facts (Director selects the explainer kind, never edited). Geometry reuses lib/charts/geometry; animation is interpolate/spring/Sequence only. Avatar PIP optional; honest hasData=false "share your numbers" fallback when facts are thin — never fabricates a chart.'
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
