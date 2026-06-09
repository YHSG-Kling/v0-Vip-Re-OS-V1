-- m203 — add 'data_steward' to managed_agents.agent_kind: the Data Steward becomes a first-class
-- Claude manager accountable for data integrity, identity resolution, and field stewardship across
-- the raw -> leads -> contacts spine (lossless promotion, dedup merges, import field-mapping). The
-- 10th manager on the egress, alongside the other 9.
ALTER TABLE public.managed_agents DROP CONSTRAINT IF EXISTS managed_agents_agent_kind_check;
ALTER TABLE public.managed_agents ADD CONSTRAINT managed_agents_agent_kind_check
  CHECK (agent_kind = ANY (ARRAY[
    'deal_coordinator','shopping_agent','listing_concierge','sphere_of_influence',
    'campaign_orchestrator','marketing_agent','asset_manager','ads_manager','ai_isa','data_steward'
  ]));
