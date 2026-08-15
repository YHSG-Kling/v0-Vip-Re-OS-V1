-- m130 — location-aware content + Apify competitor source type.
-- (1) newsletter_sections.target_locations jsonb — per-recipient section scoping
-- (2) content_topic_bank.geo_relevance jsonb — location-tagged topics boosted in picker
-- (3) widen content_topic_sources.source_type to include 'apify_actor'

alter table public.newsletter_sections
  add column if not exists target_locations jsonb;

comment on column public.newsletter_sections.target_locations is
  'Optional jsonb { cities[], states[], zip_codes[] }. NULL = render for all; populated = match recipient contacts.{city,state,zip_code} (any one match qualifies).';

alter table public.content_topic_bank
  add column if not exists geo_relevance jsonb;

comment on column public.content_topic_bank.geo_relevance is
  'Optional jsonb { cities[], states[], zip_codes[] }. NULL = platform-wide; populated = picker applies +20 score boost when recipient location matches.';

create index if not exists idx_content_topic_bank_geo
  on public.content_topic_bank using gin (geo_relevance)
  where geo_relevance is not null;

alter table public.content_topic_sources
  drop constraint if exists content_topic_sources_source_type_check;

alter table public.content_topic_sources
  add constraint content_topic_sources_source_type_check
  check (source_type in ('reddit','youtube_search','google_trends','rss','manual','apify_actor'));

comment on column public.content_topic_sources.source_type is
  'reddit | youtube_search (overloaded for Exa) | google_trends | rss | manual | apify_actor (Wave 18 — competitor handle scraping).';
