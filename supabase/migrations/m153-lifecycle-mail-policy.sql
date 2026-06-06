-- m153 — direct-mail extension to lifecycle_promo_policy.
--
-- Wave 36. Wave 27 built lifecycle_promo_policy to gate VIDEO promos
-- per (scope, event_type). The same policy table now also gates the
-- parallel direct-mail dispatch — extending the existing row instead
-- of forking a parallel lifecycle_mail_policy keeps the per-event
-- subscriber settings in ONE place (an admin who turns off
-- "just_sold" video almost certainly also wants the postcard off).
--
-- New columns:
--
--   mail_enabled        Separate from auto_spawn (which gates video).
--                       false by default — the platform doesn't blast
--                       Lob spend on the listing lifecycle until the
--                       brokerage explicitly opts in event-by-event.
--
--   mail_postcard_size  '4x6' | '6x9'. 6x9 is the premium tier and is
--                       the right pick for just_listed / just_sold /
--                       open_house where the property photo carries
--                       the impact; 4x6 for coming_soon / price_
--                       reduction where the message is the focus.
--                       Default null — the reactor's recommendation
--                       table per event_type applies.
--
--   mail_template_id    Per-(scope, event_type) Lob fallback template.
--                       Falls through to brokerages.lob_fallback_
--                       template_id when null.
--
--   mail_target_audience Which cohort to mail. Default 'farm':
--                       'farm'      — agent's farm_territories zips
--                       'sphere'    — contacts the agent has
--                                     last_contacted_at within 12mo
--                       'farm+sphere' — union of both
--                       Future: 'buyer_searches' for price_reduction.
--
--   mail_max_recipients Cap per event firing. Default 100 ≈ $78
--                       at 4x6 / $110 at 6x9. Brokerage hard cap
--                       still applies on top.

alter table public.lifecycle_promo_policy
  add column if not exists mail_enabled         boolean default false,
  add column if not exists mail_postcard_size   text,
  add column if not exists mail_template_id     text,
  add column if not exists mail_target_audience text default 'farm',
  add column if not exists mail_max_recipients  integer default 100;

alter table public.lifecycle_promo_policy
  drop constraint if exists lifecycle_promo_policy_mail_size_check;
alter table public.lifecycle_promo_policy
  add constraint lifecycle_promo_policy_mail_size_check
  check (mail_postcard_size is null or mail_postcard_size in ('4x6', '6x9'));

alter table public.lifecycle_promo_policy
  drop constraint if exists lifecycle_promo_policy_mail_audience_check;
alter table public.lifecycle_promo_policy
  add constraint lifecycle_promo_policy_mail_audience_check
  check (mail_target_audience in ('farm', 'sphere', 'farm+sphere'));

comment on column public.lifecycle_promo_policy.mail_enabled         is 'Wave 36: gates direct-mail dispatch on this (scope, event_type). Separate from auto_spawn (which gates video).';
comment on column public.lifecycle_promo_policy.mail_postcard_size   is 'Wave 36: ''4x6'' | ''6x9''. Null = reactor recommendation per event_type.';
comment on column public.lifecycle_promo_policy.mail_target_audience is 'Wave 36: which cohort to mail — farm / sphere / farm+sphere.';
