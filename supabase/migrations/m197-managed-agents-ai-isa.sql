-- m197 — add 'ai_isa' to managed_agents.agent_kind: the AI Inside Sales Agent becomes a
-- first-class Claude manager (lead qualification, nurture, re-engagement) on the egress,
-- alongside the other 8. Owns ISA-proposed client messages (GATED_CLIENT_MANAGERS).
ALTER TABLE public.managed_agents DROP CONSTRAINT IF EXISTS managed_agents_agent_kind_check;
ALTER TABLE public.managed_agents ADD CONSTRAINT managed_agents_agent_kind_check
  CHECK (agent_kind = ANY (ARRAY[
    'deal_coordinator','shopping_agent','listing_concierge','sphere_of_influence',
    'campaign_orchestrator','marketing_agent','asset_manager','ads_manager','ai_isa'
  ]));
