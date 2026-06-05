-- m159 — Asset Manager Agent (Wave 37 / 7th Managed Agent kind).
--
-- Oversees the entire image + video + brand asset library: listing
-- hero photos, agent headshots, brand logos, Remotion compositions,
-- ai_video_projects renders, asset_persona_renders, marketing_assets.
-- Spots stale assets, under-performing per-persona renders, Fair
-- Housing risk on captions, and proposes regenerate/deprecate/
-- flag resolutions through the human-approved execution flow.
--
-- The Asset Manager talks to the Marketing Agent: when the marketing-
-- agent's snapshot shows a topic crushing per-persona, the asset
-- manager can deliver the matching creative variants (per-persona
-- thumbnails, per-persona videos) on the next cycle so the
-- omnipresence fanout has assets ready to ship.
--
-- ── m159.1: widen managed_agents.agent_kind CHECK to include
--    asset_manager.

alter table public.managed_agents
  drop constraint if exists managed_agents_agent_kind_check;
alter table public.managed_agents
  add constraint managed_agents_agent_kind_check
  check (agent_kind = ANY (ARRAY[
    'deal_coordinator'::text,
    'shopping_agent'::text,
    'listing_concierge'::text,
    'sphere_of_influence'::text,
    'campaign_orchestrator'::text,
    'marketing_agent'::text,
    'asset_manager'::text
  ]));

-- ── m159.2: asset_manager_actions — mirror of marketing_agent_actions
--    so resolution actions follow the same human-approved execution
--    flow Wave 34b built. Separate table (not extending the marketing
--    one) so the action_type vocabulary stays focused per agent kind
--    + the admin UI can render them on separate tabs.

create table if not exists public.asset_manager_actions (
  id                       uuid primary key default gen_random_uuid(),
  brokerage_id             uuid not null references public.brokerages(id) on delete cascade,
  managed_agent_session_id uuid,
  action_type              text not null check (action_type in (
    'regenerate_asset',          -- re-run the generator for an existing asset (with optional new prompt)
    'deprecate_asset',           -- soft-deactivate an asset that's stale / off-brand
    'flag_asset_for_review',     -- route an asset to broker's automation_errors queue
    'request_listing_hero_photo',-- listing has no flagged is_hero; admin needs to pick one
    'request_agent_headshot',    -- agent has no current photo_url; admin should request upload
    'rerender_persona_variants', -- re-trigger asset_persona_renders for an asset across all personas
    'sync_asset_to_listing'      -- attach an existing asset to a listing it should belong to
  )),
  action_input             jsonb not null,
  rationale                text,
  status                   text not null default 'proposed' check (status in (
    'proposed', 'approved', 'executing', 'succeeded', 'failed', 'skipped'
  )),
  result                   jsonb,
  proposed_at              timestamptz default now(),
  approved_at              timestamptz,
  approved_by              uuid,
  executed_at              timestamptz
);

create index if not exists idx_asset_manager_actions_brokerage_recent
  on public.asset_manager_actions (brokerage_id, proposed_at desc);
create index if not exists idx_asset_manager_actions_status
  on public.asset_manager_actions (status, proposed_at desc);

-- ── m159.3: brand_asset_library — canonical registry of brand-level
--    assets the asset manager inventories. Reuses marketing_assets
--    for individual campaign assets; this layer is for BRAND PRIMITIVES
--    (logos, headshots, hero compositions) that get USED across many
--    campaigns. Separate so the asset-manager snapshot stays focused
--    on the "is the brokerage's brand inventory healthy?" question.

create table if not exists public.brand_asset_library (
  id              uuid primary key default gen_random_uuid(),
  brokerage_id    uuid not null references public.brokerages(id) on delete cascade,
  agent_user_id   uuid,                              -- null = brokerage-wide; set = agent-personal
  asset_kind      text not null check (asset_kind in (
    'logo', 'agent_headshot', 'team_logo', 'video_avatar', 'voice_clone',
    'brand_color_palette', 'hero_template', 'remotion_composition'
  )),
  display_name    text not null,
  primary_url     text,
  -- jsonb metadata for kind-specific fields (palette colors, voice id,
  -- avatar's did_avatar_id, composition's input prop schema, etc.)
  metadata        jsonb default '{}'::jsonb,
  is_active       boolean default true,
  -- Asset manager's snapshot reads these to detect staleness.
  last_used_at    timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index if not exists idx_brand_asset_library_active
  on public.brand_asset_library (brokerage_id, asset_kind)
  where is_active = true;

create index if not exists idx_brand_asset_library_agent
  on public.brand_asset_library (agent_user_id, asset_kind)
  where agent_user_id is not null and is_active = true;

comment on table public.asset_manager_actions is 'Wave 37: human-approved resolution ledger for the Asset Manager Agent. Same pattern as marketing_agent_actions.';
comment on table public.brand_asset_library   is 'Wave 37: canonical registry of brand-level assets (logos, headshots, voice clones, compositions). marketing_assets stays for per-campaign output assets.';
