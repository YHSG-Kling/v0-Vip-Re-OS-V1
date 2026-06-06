-- m151 — extend the EXISTING competitor_ads + add competitor_brokerages watchlist.
--
-- Wave 36. Consolidation. There's already a competitor_ads + competitor_
-- posts + ad_insights + trend_alerts system in lib/ads/ad-monitor.ts
-- (kernel-gated via canAccessFeature('competitor_monitor'), AI-generated
-- insights, COMPETITOR_CONTENT_ALERTED kernel event on high severity).
-- We don't create a parallel system — we extend the existing one with
-- the fields the Meta Ad Library + topic-bank promoter need, and add
-- one new table (the canonical watchlist) the existing system was
-- missing.
--
-- Extensions to competitor_ads:
--   provider_ad_id     The platform's own ad id. (source_platform,
--                      provider_ad_id) becomes the proper idempotency
--                      key — the existing (brokerage_id, source_platform,
--                      ad_headline) dedup is fragile because headlines
--                      can change mid-flight.
--   competitor_id      FK to the new competitor_brokerages watchlist.
--                      Nullable because the existing ingester doesn't
--                      require a watchlist row.
--   impressions_lower / impressions_upper   Meta returns ranges.
--   spend_lower_cents / spend_upper_cents   Meta returns ranges.
--   geo_relevance      jsonb mirroring content_topic_bank.geo_relevance
--                      so the promoter carries it through to the topic
--                      bank without translation.
--   engagement_score   Normalized 0-100, scored from impressions +
--                      delivery duration (long-running ads = ROI proxy).
--   ad_delivery_start / ad_delivery_stop   Meta returns these as
--                      ISO timestamps; long-running ads are higher signal.
--   categories         Heuristic tags derived from creative body
--                      ('luxury','first_time','farm_postcard','jumbo',
--                      'investor', etc.) — used by the topic-bank
--                      picker.
--
-- New table competitor_brokerages:
--   Per-tenant watchlist. The brokerage's admin adds the competitors
--   they care about by name + Meta page id (and later Google advertiser
--   id). The Meta Ad Library cron reads this list per brokerage and
--   pulls only the ads from competitors on it. Existing ad-monitor.ts
--   keeps working for manual / general ingest paths; the watchlist is
--   additive scope for the Meta-specific scheduled ingest.

alter table public.competitor_ads
  add column if not exists provider_ad_id      text,
  add column if not exists competitor_id       uuid,
  add column if not exists impressions_lower   bigint,
  add column if not exists impressions_upper   bigint,
  add column if not exists spend_lower_cents   bigint,
  add column if not exists spend_upper_cents   bigint,
  add column if not exists geo_relevance       jsonb,
  add column if not exists engagement_score    integer default 0,
  add column if not exists ad_delivery_start   timestamptz,
  add column if not exists ad_delivery_stop    timestamptz,
  add column if not exists categories          text[];

-- Idempotency key for the Meta adapter. Partial unique so existing
-- rows without provider_ad_id (the legacy ingest path) aren't churned.
create unique index if not exists uq_competitor_ads_source_provider_id
  on public.competitor_ads (source_platform, provider_ad_id)
  where provider_ad_id is not null;

-- Fast lookup for the promoter — top engagement score per brokerage.
create index if not exists idx_competitor_ads_brokerage_engagement
  on public.competitor_ads (brokerage_id, engagement_score desc);

-- The watchlist itself.
create table if not exists public.competitor_brokerages (
  id                   uuid primary key default gen_random_uuid(),
  brokerage_id         uuid not null references public.brokerages(id) on delete cascade,
  competitor_name      text not null,
  facebook_page_id     text,
  google_advertiser_id text,
  -- Geo focus the brokerage cares about for THIS competitor. The
  -- promoter weights ads that match these zips higher when promoting
  -- to content_topic_bank.
  watch_zip_codes      text[],
  is_active            boolean default true,
  created_at           timestamptz default now(),
  unique (brokerage_id, competitor_name)
);

create index if not exists idx_competitor_brokerages_active
  on public.competitor_brokerages (brokerage_id)
  where is_active = true;

-- competitor_ads.competitor_id FK we couldn't add inline because the
-- target table didn't exist yet.
alter table public.competitor_ads
  drop constraint if exists competitor_ads_competitor_id_fkey;
alter table public.competitor_ads
  add constraint competitor_ads_competitor_id_fkey
  foreign key (competitor_id)
  references public.competitor_brokerages(id)
  on delete set null;

comment on table public.competitor_brokerages       is 'Wave 36: per-tenant watchlist of competing brokerages whose ads the Meta + Google ingesters pull. Existing manual ingest paths in lib/ads/ad-monitor.ts keep working — this is additive.';
comment on column public.competitor_ads.provider_ad_id    is 'Wave 36: the platform''s ad id. (source_platform, provider_ad_id) is the canonical idempotency key.';
comment on column public.competitor_ads.engagement_score  is 'Wave 36: normalized 0-100 score from impressions + delivery duration. Read by the topic-bank promoter to pick the top N ads/cycle.';
