-- m173 — Wave 39 GEO: public, AI-search-citable landing page per render.
--
-- The differentiator no incumbent (MoxiWorks / kvCORE / Rave) ships:
-- every Remotion render the agentic OS produces becomes a crawlable,
-- schema.org-rich public page (app/v/[slug]) so ChatGPT browse /
-- Perplexity / Google AI Overviews / Claude can READ and CITE the
-- agent's listing + market videos. m172 made every render produce a
-- video + thumbnail; this makes them discoverable.
--
-- Publishing is human-gated (broker approves via the Asset Manager
-- publish_video_page action) because a public page is broadcast
-- real-estate advertising — it must carry Fair-Housing / license / EHO
-- disclosures and the broker must greenlight exposure.

alter table public.remotion_composition_renders
  add column if not exists public_slug   text,
  add column if not exists is_published  boolean not null default false,
  add column if not exists published_at   timestamptz;

-- Slugs are the public URL key — must be unique. Partial unique index so
-- only published rows compete for the namespace (NULL slugs don't clash).
create unique index if not exists uq_remotion_renders_public_slug
  on public.remotion_composition_renders (public_slug)
  where public_slug is not null;

-- The sitemap / llms.txt route scans published rows newest-first.
create index if not exists idx_remotion_renders_published
  on public.remotion_composition_renders (published_at desc)
  where is_published;

-- New Asset Manager action: publish a successful render as a public page.
alter table public.asset_manager_actions
  drop constraint if exists asset_manager_actions_action_type_check;

alter table public.asset_manager_actions
  add constraint asset_manager_actions_action_type_check
  check (action_type = any (array[
    'regenerate_asset',
    'deprecate_asset',
    'flag_asset_for_review',
    'request_listing_hero_photo',
    'request_agent_headshot',
    'rerender_persona_variants',
    'sync_asset_to_listing',
    'start_render',
    'restart_failed_render',
    'publish_video_page'
  ]));

comment on column public.remotion_composition_renders.public_slug is
  'Wave 39 GEO m173: SEO slug for the public /v/[slug] landing page. NULL until published.';
comment on column public.remotion_composition_renders.is_published is
  'Wave 39 GEO m173: broker-approved public exposure. Drives sitemap + llms.txt inclusion.';
