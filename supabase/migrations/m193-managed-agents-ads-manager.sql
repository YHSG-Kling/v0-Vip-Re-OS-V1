-- m193 — add 'ads_manager' to the managed_agents.agent_kind enum so the Ads Manager is a
-- first-class Claude manager (can have a managed_agents row + sessions), alongside the
-- other 7. It owns the paid-ad spend actions (ad_manager_actions) surfaced on the
-- Command Center, attributed via lib/kernel/manager-registry.
ALTER TABLE public.managed_agents DROP CONSTRAINT IF EXISTS managed_agents_agent_kind_check;
ALTER TABLE public.managed_agents ADD CONSTRAINT managed_agents_agent_kind_check
  CHECK (agent_kind = ANY (ARRAY[
    'deal_coordinator','shopping_agent','listing_concierge','sphere_of_influence',
    'campaign_orchestrator','marketing_agent','asset_manager','ads_manager'
  ]));
