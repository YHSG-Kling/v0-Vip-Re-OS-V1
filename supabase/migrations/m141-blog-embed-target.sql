-- m141 — extend publish_target with 'embed' for chrome-stripped iframe hosting.
--
-- Wave 32. Brokerages with Wix / Squarespace / Webflow / static HTML sites
-- can drop a one-line <iframe src="…/embed/blog/[slug]" …> onto their
-- existing pages. The /embed route renders the article body + share +
-- tracker WITHOUT the brand header / locale / chrome — the surrounding
-- site supplies its own navigation.
--
-- Targets summary after this migration:
--   · hosted     — full landing page at /blog/[slug] (with brand chrome)
--   · wordpress  — pushed to brokerage's WP site via REST
--   · embed      — chrome-stripped at /embed/blog/[slug]; intended for
--                  iframe inclusion on the brokerage's existing website
--   · both       — fires hosted + wordpress (canonical -> hosted)

alter table public.blog_posts
  drop constraint if exists blog_posts_publish_target_check;
alter table public.blog_posts
  add constraint blog_posts_publish_target_check
  check (publish_target in ('hosted','wordpress','embed','both'));
