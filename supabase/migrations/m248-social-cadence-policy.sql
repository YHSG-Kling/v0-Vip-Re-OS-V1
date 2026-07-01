-- m248: general/brand SOCIAL auto-cadence — the non-listing social gap. Listing events already
-- auto-produce social (listing-promo-social-publish), but there was no cadence for brand/engagement
-- posts (market updates, tips). Mirrors newsletter_cadence_policy: a (scope) subscribes to a
-- weekly/biweekly/monthly brand-social cadence and the social-cadence-tick cron auto-STAGES gated
-- social drafts from the topics pool across the connected platforms. Owned by the Marketing Manager.
create table if not exists social_cadence_policy (
  id                   uuid primary key default gen_random_uuid(),
  scope_type           text not null check (scope_type in ('agent','team','brokerage')),
  scope_id             uuid not null,
  brokerage_id         uuid not null,
  cadence              text not null default 'off' check (cadence in ('weekly','biweekly','monthly','off')),
  fire_day             integer,
  preferred_categories text[],
  preferred_persona    text,
  preferred_post_types text[],   -- non-listing post types to rotate (market_update / custom)
  skipped_until        date,
  updated_at           timestamptz not null default now(),
  updated_by           uuid
);
create unique index if not exists idx_social_cadence_scope on social_cadence_policy (scope_type, scope_id);
create index if not exists idx_social_cadence_brokerage on social_cadence_policy (brokerage_id);
comment on table social_cadence_policy is
  'Per-scope general/brand social auto-cadence (mirrors newsletter_cadence_policy) — the social-cadence-tick cron auto-stages gated brand social drafts (market_update/custom) from the topics pool across connected platforms.';
