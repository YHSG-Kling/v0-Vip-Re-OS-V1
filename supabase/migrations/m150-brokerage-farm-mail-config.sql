-- m150 — farm-mail per-brokerage configuration.
--
-- Wave 36. Three columns on brokerages that the farm-mail weekly cron
-- reads to decide whether + how to dispatch:
--
--   farm_mail_enabled
--     Default false. The cron skips any brokerage that hasn't opted
--     in, so we never blast a tenant who hasn't budgeted for it. The
--     admin Settings UI flips this true after the brokerage approves
--     a weekly cap.
--
--   farm_mail_max_per_week
--     Per-agent cap on contacts mailed per cycle. Default 50 ≈
--     $39/agent/week at Lob's ~$0.78/postcard rate. The cron honors
--     this AND a brokerage-wide hard cap (defined at the cron, not
--     here) so a runaway misconfig can't blow the tenant's budget.
--
--   lob_fallback_template_id
--     The Lob template id used when the AI copy gate fails or the
--     Remotion render errors. Without this, the cron skips the
--     brokerage entirely (the channel never goes dark on a real
--     send, but a dark cycle is preferable to dispatching gate-
--     rejected copy).

alter table public.brokerages
  add column if not exists farm_mail_enabled        boolean default false,
  add column if not exists farm_mail_max_per_week   integer,
  add column if not exists lob_fallback_template_id text;

create index if not exists idx_brokerages_farm_mail_enabled
  on public.brokerages (id)
  where farm_mail_enabled = true;

comment on column public.brokerages.farm_mail_enabled        is 'Wave 36: opt-in flag for the weekly farm-mail cron. Default false.';
comment on column public.brokerages.farm_mail_max_per_week   is 'Wave 36: per-agent cap on contacts mailed per cycle. Null = 50.';
comment on column public.brokerages.lob_fallback_template_id is 'Wave 36: Lob template id used when AI copy gate fails. Required for farm_mail_enabled brokerages.';
