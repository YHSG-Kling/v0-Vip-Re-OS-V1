-- m250-agent-tax-planning.sql
--
-- Self-employed agent tax planning: one persistent profile per agent per tax year — the set-aside %,
-- the agent's blended effective income-tax rate, filing status/state, and the quarterly estimated-tax
-- payments they've recorded. Feeds the tax-planning engine (lib/finance/tax-planning.ts). Owned by
-- the Finance Manager. Closes the solo-agent tax-planning gap (the set-aside calculator was UI-only).
create table if not exists agent_tax_profile (
  id                       uuid primary key default gen_random_uuid(),
  agent_id                 uuid not null,
  brokerage_id             uuid not null,
  tax_year                 integer not null,
  set_aside_percent        numeric not null default 25,
  estimated_effective_rate numeric not null default 0.12,
  filing_status            text not null default 'single',
  home_state               text,
  quarterly_payments       jsonb not null default '[]'::jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (agent_id, tax_year)
);

create index if not exists idx_agent_tax_profile_agent on agent_tax_profile (agent_id, tax_year);

comment on table agent_tax_profile is
  'Self-employed (1099) agent tax planning: set-aside %, effective rate, and recorded quarterly estimated-tax payments per tax year. Owned by Finance Manager.';
