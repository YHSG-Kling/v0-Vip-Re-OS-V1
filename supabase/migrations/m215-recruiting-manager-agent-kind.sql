-- m215: introduce the 11th Claude manager — Recruiting Manager.
-- Recruiting / talent acquisition is a distinct business domain (brokerage growth)
-- that fits no existing manager's charter (deal/buyer/seller/lead/lifetime/marketing/
-- asset/ads/data). Extend the managed_agents.agent_kind CHECK so a recruiting_manager
-- session can be spawned and governed on the same egress as the other ten.
ALTER TABLE public.managed_agents DROP CONSTRAINT IF EXISTS managed_agents_agent_kind_check;
ALTER TABLE public.managed_agents ADD CONSTRAINT managed_agents_agent_kind_check
  CHECK (agent_kind = ANY (ARRAY[
    'deal_coordinator', 'shopping_agent', 'listing_concierge', 'sphere_of_influence',
    'campaign_orchestrator', 'marketing_agent', 'asset_manager', 'ads_manager',
    'ai_isa', 'data_steward', 'recruiting_manager'
  ]));
