-- m139 — blog online-visibility + cadence policy + per-recipient view ledger.
--
-- Wave 29. Blog is the next channel to onboard against the Wave 26+27+28
-- scaffolding (composition gate, per-(asset_type, persona) perf table,
-- persona-variant post-pass, three-tier policy resolver).
--
-- Three new tables:
--
-- (1) blog_post_views — per-page-view ledger. Each blog page hit writes
--     one row. When the viewer is an identifiable contact (logged in,
--     opened from a tagged newsletter/social link, or matched via the
--     standard tracking-link contact resolver), viewer_contact_id is set.
--     Otherwise viewer_persona_snapshot can be filled by the
--     tracking-link parameter (?p=first_time_buyer when sent via
--     newsletter) so we still get persona attribution without identity.
--     viewer_ip_hash is for unique-visitor dedup without storing raw IPs
--     (Fair Housing posture: don't store the raw IP that could identify
--     a household).
--
-- (2) blog_post_share_clicks — per-share-button hit ledger. When a
--     recipient clicks "Share on Facebook" / "Share on LinkedIn" / etc.
--     from the blog post, we log the click. This is the "online visibility"
--     signal the user explicitly framed (not SEO keyword count — actual
--     share-to-network behavior).
--
-- (3) blog_cadence_policy — three-tier opt-in for "auto-generate blog
--     posts at this cadence" (weekly, biweekly, monthly, off). Mirrors
--     lifecycle_promo_policy's shape (agent/team/brokerage scope, same
--     resolution chain) so the cadence cron walks the same hierarchy.

create table if not exists public.blog_post_views (
  id                       uuid primary key default gen_random_uuid(),
  blog_post_id             uuid not null references public.blog_posts(id) on delete cascade,
  brokerage_id             uuid not null references public.brokerages(id) on delete cascade,
  viewer_contact_id        uuid references public.contacts(id) on delete set null,
  /** When viewer isn't an identified contact but the inbound URL carried
   *  a persona tag (e.g. ?p=first_time_buyer from a newsletter section
   *  link), capture it here so the per-persona aggregator still attributes
   *  the view. */
  viewer_persona_snapshot  text,
  /** Source of the visit — 'newsletter' | 'social_post' | 'organic' |
   *  'direct' | 'ai_overview' | 'unknown'. The 'ai_overview' bucket is
   *  the GEO-citation signal: visits arriving from Google AI Overviews,
   *  ChatGPT browsing, Perplexity, etc. UTM parsing fills this. */
  source                   text,
  referrer                 text,
  /** SHA-256 of (raw_ip + brokerage_salt) for unique-visitor dedup
   *  without storing the raw IP. The brokerage_salt rotates so the hash
   *  isn't a stable household identifier across years. */
  viewer_ip_hash           text,
  viewed_at                timestamptz not null default now()
);

create index if not exists idx_blog_post_views_post_recent
  on public.blog_post_views (blog_post_id, viewed_at desc);
create index if not exists idx_blog_post_views_persona_recent
  on public.blog_post_views (viewer_persona_snapshot, viewed_at desc)
  where viewer_persona_snapshot is not null;
create index if not exists idx_blog_post_views_brokerage_source
  on public.blog_post_views (brokerage_id, source, viewed_at desc);

alter table public.blog_post_views enable row level security;
create policy "service_role_full" on public.blog_post_views
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create table if not exists public.blog_post_share_clicks (
  id                       uuid primary key default gen_random_uuid(),
  blog_post_id             uuid not null references public.blog_posts(id) on delete cascade,
  brokerage_id             uuid not null references public.brokerages(id) on delete cascade,
  viewer_contact_id        uuid references public.contacts(id) on delete set null,
  viewer_persona_snapshot  text,
  /** 'facebook' | 'twitter' | 'linkedin' | 'whatsapp' | 'email_share' |
   *  'copy_link' — the share channel the recipient clicked. */
  share_channel            text not null,
  clicked_at               timestamptz not null default now()
);
create index if not exists idx_blog_post_share_clicks_post
  on public.blog_post_share_clicks (blog_post_id, clicked_at desc);

alter table public.blog_post_share_clicks enable row level security;
create policy "service_role_full" on public.blog_post_share_clicks
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create table if not exists public.blog_cadence_policy (
  id                uuid primary key default gen_random_uuid(),
  scope_type        text not null check (scope_type in ('agent','team','brokerage')),
  scope_id          uuid not null,
  /** Cadence interval. 'off' means no auto-spawn — the agent only generates
   *  on explicit click. */
  cadence           text not null check (cadence in ('weekly','biweekly','monthly','off')),
  /** Day of week / day of month the cadence cron fires for this scope.
   *  weekly+biweekly use 0-6 (Mon=0); monthly uses 1-28. */
  fire_day          integer,
  /** Top topic categories to bias the generator toward. NULL = let the
   *  topic-bank picker choose any. */
  preferred_categories text[],
  /** Persona to bias the generator toward. NULL = let the picker choose
   *  from the brokerage's top subscriber personas. */
  preferred_persona  text,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references public.users(id) on delete set null,
  unique (scope_type, scope_id)
);
create index if not exists idx_blog_cadence_policy_lookup
  on public.blog_cadence_policy (scope_type, scope_id);

alter table public.blog_cadence_policy enable row level security;
create policy "service_role_full" on public.blog_cadence_policy
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
