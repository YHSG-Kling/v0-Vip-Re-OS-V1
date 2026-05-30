-- ===========================================================================
-- 1085-team-logo-and-mls-bound-media-flags.sql
--
-- Two clarifications on the brand-compliance work:
--
-- a) Videos AND images need brokerage/team attribution. Image-generation
--    handles brokerage via 1084 + the new compositeAttributionBand, but
--    team logo was supposed to override brokerage logo for team-branded
--    agents. The team_logo lookup pointed at teams.logo_url — that column
--    did not exist on teams. Add it now.
--
-- b) MLS rules strictly forbid brokerage/agent branding on listing photos
--    and videos uploaded to the MLS. The same physical photo used in MLS
--    must NOT carry attribution, while the version used for social /
--    email / postcards MUST carry it. We track intent per asset row.
--
-- c) AI-rendered videos can't be post-processed without ffmpeg (deferred
--    to Sprint C per lib/did/index.ts). Legally-required attribution is
--    baked into the SCRIPT (the avatar verbally discloses "Brought to
--    you by [Brokerage], License #[Number]"). ai_video_projects gets a
--    has_verbal_disclosure flag + usage_intent so the compliance gate
--    can enforce: public-marketing videos must include the disclosure,
--    MLS-bound videos must NOT.
--
-- APPLIED VIA: supabase apply_migration "team_logo_and_mls_bound_media_flags"
-- ===========================================================================

ALTER TABLE public.teams
  ADD COLUMN IF NOT EXISTS logo_url text;

ALTER TABLE public.listing_media
  ADD COLUMN IF NOT EXISTS usage_intent text DEFAULT 'public_marketing'
    CHECK (usage_intent = ANY (ARRAY['mls','public_marketing','both']));

ALTER TABLE public.ai_video_projects
  ADD COLUMN IF NOT EXISTS usage_intent text DEFAULT 'public_marketing'
    CHECK (usage_intent = ANY (ARRAY['mls','public_marketing','both'])),
  ADD COLUMN IF NOT EXISTS has_verbal_disclosure boolean DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_listing_media_mls_bound
  ON public.listing_media(listing_id)
  WHERE usage_intent IN ('mls','both');
