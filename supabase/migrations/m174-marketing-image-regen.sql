-- m174 — Wave 39: make the Asset Manager's image regeneration actually fire.
--
-- The dead-flag bug (same class as the W39 thumbnail gap): the Asset
-- Manager's regenerate_asset(kind=image) handler wrote
-- marketing_assets.status='pending_regenerate' — but marketing_assets has
-- NO status column, so the update ERRORED, and even if it hadn't, nothing
-- consumed it. So "regenerate this off-brand image" was a no-op.
--
-- Fix: a real regen_status column + a cron (marketing-image-regen) that
-- drains 'requested' rows, re-runs generateImage from the stored
-- metadata.original_prompt + purpose, and swaps the asset_url. Mirrors the
-- m172 composition-render-queue loop for video.

alter table public.marketing_assets
  add column if not exists regen_status text
    check (regen_status in ('requested','processing','failed'));

-- Cron picker: drain 'requested' oldest-first; index stays tiny (partial).
create index if not exists idx_marketing_assets_regen
  on public.marketing_assets (updated_at)
  where regen_status = 'requested';

comment on column public.marketing_assets.regen_status is
  'Wave 39 m174: Asset Manager regeneration queue. requested → processing → (null on success | failed). Drained by the marketing-image-regen cron, which re-runs generateImage from metadata.original_prompt.';
