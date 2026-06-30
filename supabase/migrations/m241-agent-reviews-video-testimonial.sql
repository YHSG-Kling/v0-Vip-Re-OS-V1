-- m241 — IN-APP TESTIMONIAL (text OR video) on agent_reviews.
-- ─────────────────────────────────────────────────────────────────────────────
-- A newly-closed / lifetime client can leave a testimonial IN THE PORTAL — a few written words OR a
-- short video — that the agent can use in marketing (a video testimonial becomes a Director reel via the
-- Asset Manager). agent_reviews already holds review_text + reviewer_name + is_published; this adds the
-- video URL so a video testimonial lives in the same row (kind = video_url present ? video : text), and
-- a `kind` for clean filtering. Captured in-app, NOT a public platform review — is_published stays false
-- until the agent approves it for use. Owned by sphere_of_influence (the lifetime/reputation manager).

alter table public.agent_reviews
  add column if not exists video_url text,
  add column if not exists kind text;

-- Backfill existing rows + default new ones to 'text' (the only prior kind).
update public.agent_reviews set kind = 'text' where kind is null;

comment on column public.agent_reviews.video_url is 'm241: URL of a client VIDEO testimonial captured in the portal (null for a text testimonial).';
comment on column public.agent_reviews.kind is 'm241: text | video — the testimonial medium (video_url present ⇒ video).';
