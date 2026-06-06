-- m167 — Wave 38 organic-social baselines view (Wave 40 prep).
--
-- The wave order is: W38 (social) lands BEFORE W40 (ads) so we have
-- organic baselines to A/B test against paid. Without an organic
-- baseline, every W40 ad launch is uncalibrated — we'd be measuring
-- paid CTR with no idea whether it beats what the brokerage already
-- gets for free.
--
-- This view aggregates the last 28d of social_media_analytics joined
-- to social_posts, grouped by the dimensions an ad creator cares
-- about: (brokerage, platform, post_type). The W40 ad creator can
-- query "what's the organic engagement_rate for just_listed posts on
-- Facebook in this brokerage?" and use that as the floor a paid
-- campaign must beat to justify spend.
--
-- Derived rates are NULL when impressions=0 (avoids divide-by-zero
-- noise in the dashboard).

create or replace view public.social_post_baselines_28d as
select
  sp.brokerage_id,
  sp.platform,
  coalesce(sp.post_type, 'unknown')                       as post_type,
  count(distinct sma.post_id)                             as posts_measured,
  sum(coalesce(sma.impressions, 0))::bigint               as total_impressions,
  sum(coalesce(sma.engagements, 0))::bigint               as total_engagements,
  sum(coalesce(sma.clicks, 0))::bigint                    as total_clicks,
  case when sum(coalesce(sma.impressions, 0)) > 0
       then round(sum(coalesce(sma.engagements, 0))::numeric
                  / sum(coalesce(sma.impressions, 0))::numeric, 4)
       else null end                                      as engagement_rate,
  case when sum(coalesce(sma.impressions, 0)) > 0
       then round(sum(coalesce(sma.clicks, 0))::numeric
                  / sum(coalesce(sma.impressions, 0))::numeric, 4)
       else null end                                      as click_through_rate,
  max(sma.measured_at)                                    as last_measured_at,
  min(sma.measured_at)                                    as window_start
from public.social_posts sp
join public.social_media_analytics sma
  on sma.post_id = sp.id
where sma.measured_at >= now() - interval '28 days'
group by sp.brokerage_id, sp.platform, coalesce(sp.post_type, 'unknown');

comment on view public.social_post_baselines_28d is
  'Wave 38: per-(brokerage, platform, post_type) organic-social baselines from the last 28d of social_media_analytics. Read by the future W40 ad creator to compute the floor a paid campaign must beat. Derived rates are NULL when impressions=0.';
