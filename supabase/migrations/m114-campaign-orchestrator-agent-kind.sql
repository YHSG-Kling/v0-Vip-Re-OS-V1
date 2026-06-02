-- m114 — widen managed_agents.agent_kind to include 'campaign_orchestrator'.
-- Drop+recreate the check constraint with the new value appended.

alter table public.managed_agents
  drop constraint if exists managed_agents_agent_kind_check;

alter table public.managed_agents
  add constraint managed_agents_agent_kind_check
  check (agent_kind = any (array[
    'deal_coordinator'::text,
    'shopping_agent'::text,
    'listing_concierge'::text,
    'sphere_of_influence'::text,
    'campaign_orchestrator'::text
  ]));

comment on column public.managed_agents.agent_kind is
  '5 kinds: deal_coordinator | shopping_agent | listing_concierge | sphere_of_influence | campaign_orchestrator.';
