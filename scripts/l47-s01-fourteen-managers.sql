-- l47-s01 · THE 14TH MANAGER (applied live 2026-07-11 via MCP)
--
-- The Cron Manager joins the roster: schedules, heartbeat & loop health
-- (operations) — the manager that keeps every other manager running.
-- managed_agents.agent_kind CHECK previously allowed 11 kinds (drift:
-- compliance_officer + finance_manager were registry-only, and the new
-- cron_manager needs a policy row for future autonomy postures/grants).
-- Extended to the FULL 14-manager registry so any manager can carry a
-- managed_agents policy row.
ALTER TABLE managed_agents DROP CONSTRAINT managed_agents_agent_kind_check;
ALTER TABLE managed_agents ADD CONSTRAINT managed_agents_agent_kind_check CHECK (agent_kind = ANY (ARRAY[
  'deal_coordinator','shopping_agent','listing_concierge','sphere_of_influence','campaign_orchestrator',
  'marketing_agent','asset_manager','ads_manager','ai_isa','data_steward','recruiting_manager',
  'compliance_officer','finance_manager','cron_manager'
]::text[]));
