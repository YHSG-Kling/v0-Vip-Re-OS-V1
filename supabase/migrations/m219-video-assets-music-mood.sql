-- m219 — tag licensed music tracks with a MOOD so the Video Director can pick one.
--
-- The music infrastructure already exists (m170: video_assets.music_volume_pct /
-- music_loop / license_url, lib/remotion/music-mixer.ts amix ducking, the
-- render-coordinator's scope-cascade pick + used_music_asset_id audit). The one
-- missing piece was CREATIVE DIRECTION: nothing chose WHICH track fits the moment.
--
-- The Video Director (lib/video/video-director.ts musicMoodForSituation) now assigns a
-- per-situation mood — energetic | sophisticated | calm | upbeat | none — and stamps it
-- into the staged render's input_props.music_mood. The render coordinator
-- (lib/remotion/render-coordinator.ts pickStockAsset) PREFERS a track tagged with that
-- mood, falling back to any music asset in scope (mood-preferred, never mood-required, so
-- a brokerage with a single licensed track still gets music).
--
-- This column lets brokers tag the tracks they ALREADY licensed (license_url still
-- enforced for category='music') by mood. Nullable: an untagged track is the universal
-- fallback. No backfill, no behavior change until brokers tag tracks.

alter table public.video_assets
  add column if not exists music_mood text;

comment on column public.video_assets.music_mood is
  'Optional mood tag for category=music tracks (energetic|sophisticated|calm|upbeat). The Video Director picks a per-situation mood; the render coordinator prefers a matching track, else any music in scope. Nullable = universal fallback track.';

-- Index the music-mood lookup the coordinator runs (category + mood within a scope).
create index if not exists idx_video_assets_music_mood
  on public.video_assets (brokerage_id, scope_type, scope_id, category, music_mood)
  where category = 'music';
