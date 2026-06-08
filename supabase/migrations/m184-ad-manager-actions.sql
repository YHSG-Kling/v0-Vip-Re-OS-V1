-- m184: Ads Manager governance ledger
-- The Ads Manager is a distinct manager that proposes paid-ad SPEND actions
-- (launch / pause / shift budget / scale a winning creative) into the Command
-- Center. Money moves only after a human approves AND a hard spend cap clears —
-- mirrors marketing_agent_actions / asset_manager_actions exactly.

create table if not exists public.ad_manager_actions (
  id                       uuid primary key default gen_random_uuid(),
  brokerage_id             uuid not null references public.brokerages(id) on delete cascade,
  managed_agent_session_id uuid,
  action_type              text not null check (action_type in (
                             'launch_ad_campaign','pause_ad_campaign','shift_ad_budget','scale_ad_creative')),
  action_input             jsonb not null,
  rationale                text,
  status                   text not null default 'proposed' check (status in (
                             'proposed','approved','executing','succeeded','failed','skipped')),
  result                   jsonb,
  proposed_at              timestamptz default now(),
  approved_at              timestamptz,
  approved_by              uuid references public.users(id),
  executed_at              timestamptz
);

alter table public.ad_manager_actions enable row level security;

-- The pending-approval picker for the Command Center.
create index if not exists idx_ad_manager_actions_pending
  on public.ad_manager_actions (brokerage_id, proposed_at) where status = 'proposed';

comment on table public.ad_manager_actions is
  'Ads Manager governance ledger — propose→human approve→execute for paid-ad spend. Nothing moves money without approved_by + a server-enforced spend cap.';
