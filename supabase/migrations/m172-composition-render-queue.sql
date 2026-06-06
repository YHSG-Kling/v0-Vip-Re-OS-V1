-- m172 — Wave 39 last mile: make queued composition renders renderable.
--
-- m171 gave the Asset Manager start_render / restart_failed_render
-- actions. Both CLAIM a remotion_composition_renders row in 'queued'
-- state and note "the per-composition endpoint will pick it up on the
-- next tick" — but:
--   1. There was no picker for arbitrary compositions. Only
--      JustListedReel (listing-promo-render cron → render-just-listed)
--      and the newsletter video had render paths. A queued
--      MarketUpdateReel / JustSoldReelSquare row sat forever.
--   2. The render row carried NO inputProps and NO scope, so even a
--      generic picker had nothing to render with — it could only fall
--      back to the registry defaultProps (a generic sample, not the
--      brokerage's branded piece) and couldn't run the coordinator's
--      scope-cascaded bookend / music lookup.
--
-- This migration closes both gaps on the data side. The new generic
-- endpoint (app/api/internal/remotion/render-composition) +
-- composition-render-queue cron consume these columns; the
-- render-coordinator's finalizeCoordinatedRender reads scope_type /
-- scope_id to cascade the stock-asset lookup.

-- 1. The composition props payload the caller (Asset Manager start_render,
--    W40 ad creator, or any future producer) wants rendered. Defaults to
--    an empty object so the renderer falls back to the registry
--    defaultProps for that composition when the caller supplies nothing.
alter table public.remotion_composition_renders
  add column if not exists input_props jsonb not null default '{}'::jsonb;

-- 2. Scope for the coordinator's stock-asset cascade (agent → brokerage).
--    Mirrors the video_assets scope_type / scope_id added in m170 so a
--    solo agent's personal-brand render pulls THEIR intro/outro/music,
--    not the brokerage's shared library.
alter table public.remotion_composition_renders
  add column if not exists scope_type text not null default 'brokerage'
    check (scope_type in ('agent','team','brokerage')),
  add column if not exists scope_id uuid;

-- 3. Provenance — which producer queued this render. Lets the support
--    console / Asset Manager attribute queue depth to a source.
alter table public.remotion_composition_renders
  add column if not exists requested_via text not null default 'asset_manager'
    check (requested_via in ('asset_manager','ad_creator','cron','manual','api'));

-- Backfill scope_id for existing rows — every prior render was
-- brokerage-scoped implicitly.
update public.remotion_composition_renders
  set scope_id = brokerage_id
  where scope_id is null;

-- 4. Partial index so the queue picker (status='queued') stays cheap as
--    the renders table grows. Oldest-first drain order.
create index if not exists idx_remotion_renders_queued
  on public.remotion_composition_renders (created_at)
  where render_status = 'queued';

comment on column public.remotion_composition_renders.input_props is
  'Wave 39 m172: composition props payload the generic render endpoint passes to selectComposition. {} → registry defaultProps.';
comment on column public.remotion_composition_renders.scope_type is
  'Wave 39 m172: agent / team / brokerage — drives the coordinator stock-asset (intro/outro/music) cascade so personal-brand renders pull the agent''s own assets.';
comment on column public.remotion_composition_renders.requested_via is
  'Wave 39 m172: which producer queued this render (asset_manager / ad_creator / cron / manual / api).';
