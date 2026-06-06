-- m170 — Wave 39 music + tier-scoped stock library extension.
--
-- Three concerns the W39 closeout missed:
--   1. Background music. video_assets only had brand_intro / logo_outro
--      / b_roll / neighborhood categories. Music tracks the renderer
--      mixes UNDER the voiceover were never modeled. We add a 'music'
--      category and an intensity / loop hint so the mixer can render
--      it correctly. Reusing video_assets (vs spinning up a separate
--      music_assets table) keeps the BrollPicker UI and the
--      uploader the same surface for every stock kind.
--
--   2. Tier scope on the stock library. Today video_assets is
--      brokerage_id-scoped only — there's no path for a solo agent
--      to upload their own intro/outro/music for their personal brand
--      without polluting the brokerage's shared library. We add
--      scope_type + scope_id mirroring the lifecycle_promo_policy +
--      blog_cadence_policy + direct_mail_presets pattern.
--
--   3. Per-render audit of which intro / outro / music actually
--      stitched. The render coordinator stamps these on
--      remotion_composition_renders so the Asset Manager can answer
--      "this brokerage's videos have ZERO music in them — broker
--      hasn't uploaded any tracks".
--
-- Render-coordinator note: lib/remotion/render-coordinator.ts (new in
-- this commit) reads stock_intro_category + stock_outro_category from
-- the registry, pulls a matching video_assets row scoped to the
-- caller's (scope_type, scope_id), calls the EXISTING
-- concatIntroOutro helper for bookends, then mixes the music via
-- the new mixBackgroundMusic helper before uploading. No duplicate
-- ffmpeg pipeline.

-- 1. Tier scope on video_assets.
alter table public.video_assets
  add column if not exists scope_type text default 'brokerage'
    check (scope_type in ('agent','team','brokerage')),
  add column if not exists scope_id   uuid;

-- Backfill existing rows — every row was brokerage-scoped implicitly.
update public.video_assets
  set scope_type = 'brokerage', scope_id = brokerage_id
  where scope_id is null;

create index if not exists idx_video_assets_scope
  on public.video_assets (brokerage_id, scope_type, scope_id);

-- 2. Widen the category set to include music + license metadata.
-- music_volume_pct — the renderer mixes at this volume relative
-- to the voiceover. Defaults to 20% so the track sits under the
-- voice without competing.
-- license_url — where the broker bought the track from; required for
-- music to defend ASCAP / BMI claims on social posts.
-- duration_seconds is already on the table.
alter table public.video_assets
  add column if not exists music_volume_pct integer
    check (music_volume_pct between 0 and 100),
  add column if not exists music_loop boolean default true,
  add column if not exists license_url text,
  add column if not exists license_attribution text;

-- 3. Per-render audit on which stock assets actually stitched.
alter table public.remotion_composition_renders
  add column if not exists used_intro_asset_id uuid references public.video_assets(id),
  add column if not exists used_outro_asset_id uuid references public.video_assets(id),
  add column if not exists used_music_asset_id uuid references public.video_assets(id);

create index if not exists idx_remotion_renders_music
  on public.remotion_composition_renders (used_music_asset_id)
  where used_music_asset_id is not null;

comment on column public.video_assets.scope_type is
  'Wave 39: agent / team / brokerage scope so solo agents can upload their personal-brand assets without polluting the brokerage library.';
comment on column public.video_assets.music_volume_pct is
  'Wave 39: 0-100 volume the mixer applies to this music track relative to the voiceover. Default 20% sits under voice without competing.';
comment on column public.video_assets.license_url is
  'Wave 39: track license URL (Epidemic Sound / Artlist / Pond5). REQUIRED for music to defend royalty claims on social posts.';
