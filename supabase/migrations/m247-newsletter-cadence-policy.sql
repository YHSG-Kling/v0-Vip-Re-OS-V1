-- m247: newsletter auto-cadence — the last standalone marketing type without one. Mirrors
-- blog_cadence_policy: a (scope_type, scope_id) subscribes to a weekly/biweekly/monthly newsletter
-- and the newsletter-cadence-tick cron auto-STAGES a GATED draft (approval_status pending) from the
-- topics pool, so no human has to build a newsletter every cycle. 'off' disables; skipped_until
-- lets a manager pause without losing the subscription.
create table if not exists newsletter_cadence_policy (
  id                   uuid primary key default gen_random_uuid(),
  scope_type           text not null check (scope_type in ('agent','team','brokerage')),
  scope_id             uuid not null,
  brokerage_id         uuid not null,
  cadence              text not null default 'off' check (cadence in ('weekly','biweekly','monthly','off')),
  fire_day             integer,
  preferred_categories text[],
  preferred_persona    text,
  skipped_until        date,
  updated_at           timestamptz not null default now(),
  updated_by           uuid
);
create unique index if not exists idx_newsletter_cadence_scope on newsletter_cadence_policy (scope_type, scope_id);
create index if not exists idx_newsletter_cadence_brokerage on newsletter_cadence_policy (brokerage_id);
comment on table newsletter_cadence_policy is
  'Per-scope newsletter auto-cadence subscription (mirrors blog_cadence_policy) — the newsletter-cadence-tick cron auto-stages a gated newsletter draft from the topics pool on the chosen cadence.';
