-- m142 — personal_website_url on users + (optional) agents.public_slug for
-- platform-hosted agent profiles.
--
-- Wave 33. The user clarified: not every brokerage has its own website,
-- and not every agent on a team-branded brokerage wants to embed at the
-- brokerage URL. The agent's PERSONAL website (their own real-estate
-- pro site — Squarespace / Wix / Realtor.com profile / custom domain)
-- is what they'd point their iframe embed at, or what they'd want
-- canonicalized when the blog publishes to the hosted landing page.
--
-- This is a USER-LEVEL field, distinct from brokerages.website which
-- exists for the broker's site. Both can coexist: a brokerage with a
-- main site AND an agent with a separate personal site.

alter table public.users
  add column if not exists personal_website_url text;

-- Soft validation via a CHECK that rejects obviously-bad inputs (empty,
-- no scheme). Full URL parsing is the application's job — the DB
-- constraint just prevents the worst class of garbage.
alter table public.users
  add constraint users_personal_website_url_format
  check (
    personal_website_url is null
    or (personal_website_url ~ '^https?://[^[:space:]]+$' and length(personal_website_url) <= 500)
  );

comment on column public.users.personal_website_url is
  'Wave 33 — agent''s personal real-estate website (Realtor.com profile, Wix, Squarespace, custom domain). Used as the canonical embed/CSP origin for /embed/blog when set; falls back to brokerage website when not.';
