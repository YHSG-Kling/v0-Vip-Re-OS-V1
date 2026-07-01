-- m251-all-tools-every-tier-packaging.sql
--
-- Pricing packaging: give EVERY tier the full tool capability set (portal, basic_ai, core_crm,
-- team_features, accounting_sync, compliance). Tiers now differ only by SCALE — max_agents (seats),
-- max_brokerages, and the multi-location-only flags (usage_metering, multi_brokerage). Executes the
-- "all tools to every tier, price by scale" decision. Idempotent (jsonb concat sets the keys true).
update subscription_tiers
set features = features || '{"team_features":true,"accounting_sync":true,"compliance":true}'::jsonb
where tier_name = 'solo_agent';

update subscription_tiers
set features = features || '{"accounting_sync":true,"compliance":true}'::jsonb
where tier_name = 'team';
