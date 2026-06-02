-- m126 — widen managed_agents.agent_kind to include 'marketing_agent'.
-- The 6th Managed Agent kind. Owns the BRAND/PROMOTION marketing lane
-- (1:many — Just Listed reels, market reports, brand-building social,
-- listing-launch sequences) — distinct from campaign_orchestrator which
-- owns the 1:1 contact lane.

alter table public.managed_agents
  drop constraint if exists managed_agents_agent_kind_check;

alter table public.managed_agents
  add constraint managed_agents_agent_kind_check
  check (agent_kind = any (array[
    'deal_coordinator'::text,
    'shopping_agent'::text,
    'listing_concierge'::text,
    'sphere_of_influence'::text,
    'campaign_orchestrator'::text,
    'marketing_agent'::text
  ]));

comment on column public.managed_agents.agent_kind is
  '6 kinds: deal_coordinator | shopping_agent | listing_concierge | sphere_of_influence | campaign_orchestrator | marketing_agent. marketing_agent owns the 1:many brand/promotion lane.';
