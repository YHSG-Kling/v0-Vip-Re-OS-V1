-- m163 — social_post_presets (Wave 37 final bundle channel).
--
-- Different shape from email/sms presets because social is multi-
-- platform: a single preset can fire to N social_posts rows (one
-- per target platform). Caption per platform optionally overrides
-- the canonical caption (LinkedIn likes longer-form; TikTok/IG
-- prefer shorter; Twitter/X is character-capped).
--
-- The existing publish-social-posts cron picks up status='scheduled'
-- rows on its */15 min tick — we just stage the rows here and let
-- the existing publisher handle the channel-specific egress.

create table if not exists public.social_post_presets (
  id                       uuid primary key default gen_random_uuid(),
  brokerage_id             uuid not null references public.brokerages(id) on delete cascade,
  scope_type               text not null default 'brokerage' check (scope_type in ('agent', 'team', 'brokerage')),
  scope_id                 uuid not null,
  name                     text not null,
  /** Canonical caption applied to every platform unless overridden in
   *  platform_overrides jsonb keyed by platform name. */
  caption                  text not null,
  /** Optional media URLs to attach (image or video). Validated only
   *  for length; specific platform support enforced at publish time. */
  media_urls               text[],
  /** Target platforms: 'facebook'|'instagram'|'linkedin'|'twitter'|
   *  'tiktok'|'youtube_shorts'|'pinterest'|'google_business'. The
   *  publisher cron walks this list when dispatching. */
  target_platforms         text[] not null default '{}',
  /** Platform-specific caption overrides. Shape:
   *    { "twitter": "...", "linkedin": "..." } */
  platform_overrides       jsonb default '{}'::jsonb,
  compliance_event_id      uuid references public.compliance_events(id) on delete set null,
  is_active                boolean default true,
  created_by               uuid,
  created_at               timestamptz default now(),
  updated_at               timestamptz default now(),
  unique (brokerage_id, name)
);

create index if not exists idx_social_post_presets_scope
  on public.social_post_presets (brokerage_id, scope_type, scope_id)
  where is_active = true;

comment on table public.social_post_presets is 'Wave 37: locked social-post presets. One preset → N social_posts rows (one per target platform) staged status=scheduled for the publish-social-posts cron.';
