-- m129 — seed platform-wide Exa neural-search queries + RSS industry feeds
-- for the Wave 17 content-intel crons.

insert into public.content_topic_sources (source_type, source_config, label, brokerage_id, is_active)
values
  ('youtube_search', '{"query":"what first-time home buyers should know about mortgage rates this month","withinDays":14,"type":"neural"}'::jsonb,
    'Exa: first-time buyer mortgage education', null, true),
  ('youtube_search', '{"query":"home seller pricing strategy in a shifting market","withinDays":21,"type":"neural"}'::jsonb,
    'Exa: seller pricing strategy', null, true),
  ('youtube_search', '{"query":"closing cost surprises homebuyers should plan for","withinDays":30,"type":"neural"}'::jsonb,
    'Exa: closing cost reality', null, true),
  ('youtube_search', '{"query":"home inspection red flags every buyer should look for","withinDays":30,"type":"neural"}'::jsonb,
    'Exa: inspection red flags', null, true),
  ('youtube_search', '{"query":"neighborhood walkability and home value relationship","withinDays":30,"type":"neural"}'::jsonb,
    'Exa: neighborhood value drivers', null, true),
  ('youtube_search', '{"query":"NAR settlement impact buyer agency 2026","withinDays":21,"category":"news","type":"neural"}'::jsonb,
    'Exa: NAR settlement consumer impact', null, true),
  ('rss', '{"feed_url":"https://www.housingwire.com/feed/","source_trust":85}'::jsonb,
    'HousingWire RSS', null, true),
  ('rss', '{"feed_url":"https://www.inman.com/feed/","source_trust":85}'::jsonb,
    'Inman RSS', null, true),
  ('rss', '{"feed_url":"https://www.nar.realtor/newsroom/feed","source_trust":90}'::jsonb,
    'NAR newsroom RSS', null, true),
  ('rss', '{"feed_url":"https://www.bankrate.com/mortgages/feed/","source_trust":75}'::jsonb,
    'Bankrate mortgages RSS', null, true)
on conflict do nothing;
