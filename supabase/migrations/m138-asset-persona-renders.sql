-- m138 — generalize newsletter_video_persona_renders → asset_persona_renders.
--
-- Wave 28. Wave 22 created newsletter_video_persona_renders as a sibling
-- to newsletter_video_renders. Wave 27 added the listing-lifecycle promo
-- family (7 event types), each of which can carry the SAME per-persona
-- thumbnail + intro-overlay treatment. Wave 28 forces the second use case
-- → time to extract the shared shape.
--
-- The new asset_persona_renders table keys on (asset_type, asset_id) so
-- ANY video asset (newsletter, listing-promo, podcast video, future
-- channels) can register persona variants in the same place. The video
-- post-pass module (lib/video/persona-variant-post-pass.ts) writes here;
-- per-channel publish loops read from here at recipient routing time.
--
-- Migration strategy:
--   1. Create asset_persona_renders with the generalized shape
--   2. Backfill from newsletter_video_persona_renders rows (asset_type='newsletter_campaign')
--   3. Keep the OLD table around as a read-only view for the publish loop
--      backward compat. The Wave 28 code migration switches readers to the
--      new table; the view is just a safety net for any external consumer
--      (we have none in production but the contract bridge avoids surprise).
--   4. Indexes on the access patterns: (asset_type, asset_id) lookup,
--      (brokerage_id, created_at desc) for admin observability.

create table if not exists public.asset_persona_renders (
  id                          uuid primary key default gen_random_uuid(),
  asset_type                  text not null
                              check (asset_type in (
                                'newsletter_campaign',
                                'newsletter_video',
                                'listing_promo',
                                'podcast_episode',
                                'social_post',
                                'blog_post',
                                'direct_mail',
                                'landing_page',
                                'marketing_plan_item'
                              )),
  asset_id                    uuid not null,
  brokerage_id                uuid not null references public.brokerages(id) on delete cascade,
  persona                     text not null,
  composite_video_url         text,
  thumbnail_url               text,
  status                      text not null default 'queued'
                              check (status in ('queued','rendering','completed','failed','skipped')),
  failure_reason              text,
  created_at                  timestamptz not null default now(),
  completed_at                timestamptz,
  unique (asset_type, asset_id, persona)
);

create index if not exists idx_asset_persona_renders_asset
  on public.asset_persona_renders (asset_type, asset_id);

create index if not exists idx_asset_persona_renders_brokerage_recent
  on public.asset_persona_renders (brokerage_id, created_at desc);

alter table public.asset_persona_renders enable row level security;

create policy "service_role_full"
  on public.asset_persona_renders
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- Backfill newsletter rows. The existing column shape maps cleanly:
--   newsletter_campaign_id → asset_id (asset_type='newsletter_campaign')
--   composite_video_url, thumbnail_url, status, failure_reason kept as-is.
insert into public.asset_persona_renders
  (asset_type, asset_id, brokerage_id, persona,
   composite_video_url, thumbnail_url, status, failure_reason,
   created_at, completed_at)
select
  'newsletter_campaign',
  newsletter_campaign_id,
  brokerage_id,
  persona,
  composite_video_url,
  thumbnail_url,
  status,
  failure_reason,
  created_at,
  completed_at
from public.newsletter_video_persona_renders
on conflict (asset_type, asset_id, persona) do nothing;

-- Drop the old table and replace it with a backward-compat view. Internal
-- consumers (publish-newsletters, render-newsletter-video) migrate to the
-- new table in Wave 28 code; the view is a no-cost contract bridge if any
-- external reader exists.
drop table public.newsletter_video_persona_renders cascade;

create view public.newsletter_video_persona_renders as
  select
    id,
    -- preserves the old column name for any read-side compat
    asset_id as newsletter_campaign_id,
    brokerage_id,
    persona,
    composite_video_url,
    thumbnail_url,
    status,
    failure_reason,
    created_at,
    completed_at
  from public.asset_persona_renders
  where asset_type = 'newsletter_campaign';
