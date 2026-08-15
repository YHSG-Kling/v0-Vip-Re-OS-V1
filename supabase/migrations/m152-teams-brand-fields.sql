-- m152 — team-level branding fields (Wave 36 tier-aware cascade fix).
--
-- Wave 36 correction: every direct-mail composition was reading brand
-- only from brokerages.*, missing the canonical agent → team →
-- brokerage subscription tier model. Teams that pay for their own
-- branding (and ALL teams running a team-tier subscription do) have
-- their own logos + colors that should override the brokerage's on
-- any piece a team member sends. The team's letterhead is what the
-- team's contacts recognize; the brokerage's brand is the safety net.
--
-- teams.logo_url already exists. We add the rest of the visual brand
-- surface so the resolver's middle tier has something to return.
--
--   primary_color   The team's wordmark / hero color. Used as the
--                   brand strip + accent ribbon on postcards.
--   accent_color    Pill/CTA/highlight color.
--   website         The team's public site (separate from brokerage's).
--                   Falls back to brokerage.website when null.
--   phone           Team's general inbound line. The agent's
--                   phone_office still overrides per-piece.
--   tagline         "Where Tampa Bay Sells Faster" etc. — appears on
--                   letter footers + business-card backs (when we
--                   ship that comp).
--
-- LICENSE intentionally NOT added here. Direct-mail compliance
-- requires the AGENT's individual license number, not the team's
-- (teams don't carry their own broker license — they operate under
-- the brokerage's). The resolver pulls license from agents.* /
-- brokerages.* and skips teams.

alter table public.teams
  add column if not exists primary_color text,
  add column if not exists accent_color  text,
  add column if not exists website       text,
  add column if not exists phone         text,
  add column if not exists tagline       text;

comment on column public.teams.primary_color is 'Wave 36 tier-aware brand cascade: team-level primary color, overrides brokerage on pieces sent by team members.';
comment on column public.teams.accent_color  is 'Wave 36 tier-aware brand cascade: team-level accent / CTA color.';
comment on column public.teams.website       is 'Wave 36: team-level public website; falls back to brokerage.website when null.';
comment on column public.teams.phone         is 'Wave 36: team general inbound line; agent.phone_office still overrides per-piece.';
comment on column public.teams.tagline       is 'Wave 36: team tagline shown on letter footers + business-card backs.';
