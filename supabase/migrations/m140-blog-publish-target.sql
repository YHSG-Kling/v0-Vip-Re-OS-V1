-- m140 — blog publish targets (hosted | wordpress | both) + denormalized view count.
--
-- Wave 31. The user clarified: many brokerages don't run WordPress, but
-- every brokerage CAN publish to a hosted blog landing page on the
-- platform (mirroring the existing /listing/[slug] pattern). Two output
-- targets:
--
--   · 'hosted'    — public landing page at /blog/[slug]. Brokerage adds
--                   a link to their main site. Default for new posts.
--   · 'wordpress' — pushed to brokerage's WP site via REST API. Existing
--                   Wave 29/30 flow. Available when credentials are set.
--   · 'both'      — published to BOTH endpoints; canonical URL points
--                   to the hosted page (WordPress gets the rel="canonical"
--                   tag set to the hosted URL so search engines don't
--                   penalize duplicate content).
--
-- Backfill: existing posts with wordpress_post_id set → publish_target='wordpress';
-- everything else → 'hosted'.

alter table public.blog_posts
  add column if not exists publish_target text not null default 'hosted'
    check (publish_target in ('hosted','wordpress','both'));

update public.blog_posts
  set publish_target = 'wordpress'
  where wordpress_post_id is not null and publish_target = 'hosted';

-- Denormalized view + share counters so the landing page can show a
-- "100 readers this week" badge without a live count() join.
-- Aggregator + tracker endpoints maintain these.
alter table public.blog_posts
  add column if not exists view_count_total integer not null default 0;
alter table public.blog_posts
  add column if not exists share_count_total integer not null default 0;

-- Used by the public landing page's hot-recent-posts widget.
create index if not exists idx_blog_posts_published_recent
  on public.blog_posts (brokerage_id, published_at desc)
  where publish_status = 'published';
