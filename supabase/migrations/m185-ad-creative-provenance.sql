-- m185: ad-creative provenance — where the creative came from.
-- ad_creative_variations already carries media_asset_url + destination_url; this
-- adds the traceable link to the ASSET MANAGER output that supplied the media and
-- to the high-performing COMPETITOR ad that inspired the (new, non-copied) copy.

alter table public.ad_creative_variations
  add column if not exists source_marketing_asset_id uuid references public.marketing_assets(id) on delete set null,
  add column if not exists competitor_ad_id uuid references public.competitor_ads(id) on delete set null,
  add column if not exists generated_from text;  -- 'manual' | 'campaign' | 'competitor'

comment on column public.ad_creative_variations.source_marketing_asset_id is
  'The Asset Manager output (marketing_assets) whose avatar/listing video backs this ad creative.';
comment on column public.ad_creative_variations.competitor_ad_id is
  'The high-performing competitor ad (competitor_ads) that inspired this creative — provenance only; copy is newly generated, never copied.';

create index if not exists idx_ad_creative_competitor on public.ad_creative_variations (competitor_ad_id) where competitor_ad_id is not null;
