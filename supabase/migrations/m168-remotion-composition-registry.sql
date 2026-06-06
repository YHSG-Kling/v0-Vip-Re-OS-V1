-- m168 — Wave 39 Remotion composition registry.
--
-- Until now the composition library was an in-repo list (the
-- registrations in remotion/Root.tsx); the Asset Manager couldn't
-- see which compositions existed, which were being USED, which had
-- gone stale, or which tiers had access. m168 adds a database row
-- per composition so the kernel can read + reason over the library
-- the same way it reasons over presets / bundles / brand assets.
--
-- Two tables:
--   remotion_compositions       — one row per composition id. Includes
--                                  format, dimensions, tier gates, SEO
--                                  hint, status, last-used timestamp.
--                                  Read by lib/remotion/registry.ts +
--                                  the asset-manager snapshot.
--   remotion_composition_renders — per-render audit row. Lets the
--                                  Asset Manager count usage per
--                                  composition + tenant to surface
--                                  "this composition has been
--                                  rendered 200 times this month for
--                                  brokerage X" / "this composition
--                                  hasn't been used by anyone in 90d
--                                  → deprecate candidate".
--
-- Tier gating shape:
--   tier_access text[] — one of {'platform', 'multi_location',
--                                'brokerage', 'team', 'solo_agent'}
--   The W40 ad creator + content engine consult
--   lib/remotion/registry.ts::canAccessComposition(tier, id) before
--   queuing a render. Platform-tier rows are usable by every paying
--   tenant; solo_agent rows are restricted to that tier (typically
--   pieces a brokerage doesn't want individual agents producing
--   without oversight).

create table if not exists public.remotion_compositions (
  -- composition_id mirrors remotion/Root.tsx <Composition id="...">.
  -- Brand/topic registry rows that aren't shipped Compositions yet
  -- can pre-register here so the Asset Manager + admin UI surface
  -- them as "coming next" candidates.
  composition_id           text primary key,
  -- human label for admin UI + Asset Manager reasoning. NOT the
  -- og:title — that's seo_title.
  display_name             text not null,
  /** Visual category, drives admin filtering. */
  category                 text not null
    check (category in (
      'listing','explainer','presentation','market_update',
      'testimonial','open_house','coming_soon','neighborhood',
      'affordability','agent_avatar','lead_magnet','postcard',
      'newsletter','thumbnail'
    )),
  /** Orientation — square|vertical|horizontal|static_card|postcard. */
  orientation              text not null
    check (orientation in ('square','vertical','horizontal','static_card','postcard')),
  width                    integer not null,
  height                   integer not null,
  duration_frames          integer not null,
  fps                      integer not null default 30,
  /** Whether this composition requires a D-ID avatar render upstream.
   *  Used for cost forecasting + tier gating (some tiers exclude
   *  D-ID-required formats to control the per-render spend). */
  requires_did_avatar      boolean not null default false,
  /** Whether the composition's caller path expects an ElevenLabs
   *  voiceover mp3. Distinct from avatar — testimonial reels can
   *  layer voice without avatar. */
  requires_voiceover       boolean not null default false,
  /** Tier access — array of canonical subscription tier names.
   *  Empty array = no access (used to deprecate without delete). */
  tier_access              text[] not null
    default array['platform','multi_location','brokerage','team','solo_agent']::text[],
  /** Active flag — soft deactivation so historical renders still
   *  resolve their composition row. The Asset Manager looks at
   *  is_active=true rows in its weekly snapshot. */
  is_active                boolean not null default true,
  /** SEO hint — used by the render endpoint as the og:title /
   *  twitter:title when this composition (or its thumbnail) is
   *  shipped as an OG image. AI-search readable. */
  seo_title                text,
  seo_description          text,
  /** Companion thumbnail composition id (almost always
   *  'VideoCoverThumb' but reserved for future per-format thumbs).
   *  When set, the renderer queues a renderStill() pass with that
   *  composition right after the video render lands. */
  thumbnail_composition_id text,
  /** Notes the Asset Manager attaches when proposing deprecate. */
  asset_manager_notes      text,
  /** Last time ANY tenant rendered this composition. NULL until first
   *  render; updated by the renderer's success path. */
  last_rendered_at         timestamptz,
  created_at               timestamptz default now(),
  updated_at               timestamptz default now()
);

create index if not exists idx_remotion_compositions_active
  on public.remotion_compositions (is_active)
  where is_active = true;
create index if not exists idx_remotion_compositions_category
  on public.remotion_compositions (category)
  where is_active = true;

create table if not exists public.remotion_composition_renders (
  id                  uuid primary key default gen_random_uuid(),
  brokerage_id        uuid not null references public.brokerages(id) on delete cascade,
  composition_id      text not null references public.remotion_compositions(composition_id),
  -- agent_id is users.id (matches the rest of the video-side schema).
  agent_user_id       uuid,
  -- The entity the render relates to (a listing, a contact, a campaign).
  entity_type         text,
  entity_id           uuid,
  /** Whether this render included a D-ID hit and/or voiceover, so
   *  cost rollups stay accurate even when the composition's required
   *  flags change later. */
  used_did_avatar     boolean not null default false,
  used_voiceover      boolean not null default false,
  render_status       text not null default 'queued'
    check (render_status in ('queued','rendering','succeeded','failed','cancelled')),
  /** Public CDN URL of the finished render. NULL until succeeded. */
  output_url          text,
  /** Thumbnail URL — generated alongside (renderStill on the
   *  composition's thumbnail_composition_id). */
  thumbnail_url       text,
  error_message       text,
  created_at          timestamptz default now(),
  completed_at        timestamptz
);

create index if not exists idx_remotion_renders_brokerage_recent
  on public.remotion_composition_renders (brokerage_id, created_at desc);
create index if not exists idx_remotion_renders_composition_status
  on public.remotion_composition_renders (composition_id, render_status, created_at desc);

-- Seed every composition currently registered in remotion/Root.tsx.
-- New compositions added later land via additional INSERT
-- migrations; the registry is the source of truth.
insert into public.remotion_compositions (composition_id, display_name, category, orientation, width, height, duration_frames, fps, requires_did_avatar, requires_voiceover, tier_access, seo_title, seo_description, thumbnail_composition_id)
values
  -- Vertical 9:16 (organic reels)
  ('JustListedReel',            'Just Listed Reel (Vertical)',         'listing',       'vertical',      1080, 1920, 750, 30, false, false, array['platform','multi_location','brokerage','team','solo_agent'], 'Just Listed — new home on the market',                'New listing reel narrated and branded for the agent.', 'VideoCoverThumb'),
  ('NewsletterDigestVideo',     'Newsletter Digest (Vertical)',        'newsletter',    'vertical',      1080, 1920, 600, 30, false, false, array['platform','multi_location','brokerage'],                      'Weekly market digest',                                  'Weekly newsletter video for sphere outreach.',         'NewsletterDigestThumb'),
  -- Square 1:1 (paid + organic feed)
  ('JustListedReelSquare',      'Just Listed Reel (Square)',           'listing',       'square',        1080, 1080, 360, 30, false, false, array['platform','multi_location','brokerage','team','solo_agent'], 'Just Listed — see this home',                          'Square paid-ad version of the Just Listed reel.',      'VideoCoverThumb'),
  ('JustSoldReelSquare',        'Just Sold Reel (Square)',             'listing',       'square',        1080, 1080, 360, 30, false, false, array['platform','multi_location','brokerage','team','solo_agent'], 'Just Sold — closed in record time',                    'Social proof reel for a recently closed listing.',      'VideoCoverThumb'),
  ('ComingSoonReel',            'Coming Soon Teaser',                  'coming_soon',   'square',        1080, 1080, 360, 30, false, false, array['platform','multi_location','brokerage','team'],              'Coming soon to the market',                            'Pre-listing teaser reel.',                             'VideoCoverThumb'),
  ('OpenHouseAnnounceReel',     'Open House Announcement',             'open_house',    'square',        1080, 1080, 360, 30, false, false, array['platform','multi_location','brokerage','team','solo_agent'], 'Open House — date, time, address',                     'Open house event announcement reel.',                  'VideoCoverThumb'),
  ('AgentTalkingHeadReel',      'Agent Talking Head',                  'agent_avatar',  'square',        1080, 1080, 420, 30, true,  true,  array['platform','multi_location','brokerage','team'],              'Meet your agent',                                      'D-ID avatar single-take reel.',                         'VideoCoverThumb'),
  ('AgentExplainerReel',        'Agent Explainer (3-bullet)',          'explainer',     'square',        1080, 1080, 540, 30, true,  true,  array['platform','multi_location','brokerage','team'],              'Quick explainer from your agent',                      'Three-bullet explainer with avatar PIP.',              'VideoCoverThumb'),
  ('TestimonialReel',           'Client Testimonial Reel',             'testimonial',   'square',        1080, 1080, 420, 30, false, false, array['platform','multi_location','brokerage','team','solo_agent'], '5-star client review',                                 'Quoted client testimonial with agent reaction.',        'VideoCoverThumb'),
  ('NeighborhoodSpotlightReel', 'Neighborhood Spotlight',              'neighborhood',  'square',        1080, 1080, 480, 30, false, true,  array['platform','multi_location','brokerage'],                      'Neighborhood spotlight',                                'B-roll-driven neighborhood reel with data highlights.', 'VideoCoverThumb'),
  ('MarketUpdateReel',          'Market Update Reel',                  'market_update', 'square',        1080, 1080, 480, 30, true,  true,  array['platform','multi_location','brokerage'],                      'This month in your market',                            'Three-stat market update reel.',                       'VideoCoverThumb'),
  ('AffordabilitySnapshotReel', 'Affordability Snapshot Reel',         'affordability', 'square',        1080, 1080, 450, 30, false, false, array['platform','multi_location','brokerage','team'],              'What your budget buys this week',                      'Buyer-side reel showing three listings for a target monthly budget.', 'VideoCoverThumb'),
  -- Horizontal 16:9 (YouTube / CTV / FB in-stream)
  ('JustListedReelHorizontal',  'Just Listed Reel (Horizontal)',       'listing',       'horizontal',    1920, 1080, 600, 30, false, true,  array['platform','multi_location','brokerage'],                      'Just Listed — full-screen tour',                        'Horizontal video ad for YouTube and CTV.',             'VideoCoverThumb'),
  ('ListingPresentationSlide',  'Listing Presentation Slide',          'presentation',  'horizontal',    1920, 1080, 180, 30, true,  true,  array['platform','multi_location','brokerage','team'],              'Your home, the market, the strategy',                   'One slide of a chained narrated listing presentation.',  'VideoCoverThumb'),
  ('BuyerConsultationSlide',    'Buyer Consultation Slide',            'presentation',  'horizontal',    1920, 1080, 180, 30, true,  true,  array['platform','multi_location','brokerage','team'],              'Your buyer journey — step by step',                     'One slide of a chained buyer consultation presentation.', 'VideoCoverThumb'),
  -- Static cards
  ('NewsletterDigestThumb',     'Newsletter Digest Thumbnail',         'thumbnail',     'static_card',   1200,  630,   1, 30, false, false, array['platform','multi_location','brokerage'],                      'Weekly market digest',                                  'Inbox preview card for the weekly newsletter video.',  null),
  ('LeadMagnetCard',            'Lead Magnet Card (OG 1200×630)',      'lead_magnet',   'static_card',   1200,  630,   1, 30, false, false, array['platform','multi_location','brokerage','team'],              'Free home valuation guide',                            'Open-Graph lead-magnet card for ads.',                  null),
  ('VideoCoverThumb',           'Universal Video Thumbnail',           'thumbnail',     'static_card',   1200,  630,   1, 30, false, false, array['platform','multi_location','brokerage','team','solo_agent'], 'Watch this from your agent',                            'AI-search-discoverable thumbnail every video uses.',    null),
  -- Direct mail
  ('PostcardFront4x6',          'Postcard Front 4×6',                  'postcard',      'postcard',      1275, 1875,   1, 30, false, false, array['platform','multi_location','brokerage','team','solo_agent'], null, null, null),
  ('PostcardBack4x6',           'Postcard Back 4×6',                   'postcard',      'postcard',      1275, 1875,   1, 30, false, false, array['platform','multi_location','brokerage','team','solo_agent'], null, null, null),
  ('PostcardFront6x9',          'Postcard Front 6×9',                  'postcard',      'postcard',      1875, 2775,   1, 30, false, false, array['platform','multi_location','brokerage','team'],              null, null, null),
  ('PostcardBack6x9',           'Postcard Back 6×9',                   'postcard',      'postcard',      1875, 2775,   1, 30, false, false, array['platform','multi_location','brokerage','team'],              null, null, null)
on conflict (composition_id) do nothing;

comment on table public.remotion_compositions is
  'Wave 39: source of truth for the Remotion composition library. Read by the W40 ad creator + content engine to pick + tier-gate compositions; read by the Asset Manager to surface usage / staleness / deprecate candidates.';
comment on table public.remotion_composition_renders is
  'Wave 39: per-render audit. Feeds Asset Manager usage rollups + cost forecasts.';
