-- m189: governed client-message ledger for the managed agents.
-- The deal-critical managers (Listing Concierge, Deal Coordinator) no longer send
-- seller/buyer updates autonomously. They PROPOSE the message here; a human approves
-- (or edits) it in the Command Center; approval sends it. ONE ledger for every
-- manager's client-facing message — not a per-manager table — so the Command Center
-- stays the single review surface.

create table if not exists public.agent_client_messages (
  id                       uuid primary key default gen_random_uuid(),
  brokerage_id             uuid not null references public.brokerages(id) on delete cascade,
  managed_agent_session_id uuid,
  agent_kind               text not null,
  entity_type              text not null,
  entity_id                uuid,
  recipient_contact_id     uuid,
  audience                 text not null check (audience in ('seller','buyer','lead','agent')),
  subject                  text,
  body                     text not null,
  rationale                text,
  status                   text not null default 'proposed'
                             check (status in ('proposed','approved','sent','rejected','failed')),
  proposed_at              timestamptz default now(),
  approved_by              uuid references public.users(id),
  approved_at              timestamptz,
  sent_at                  timestamptz,
  send_error               text,
  created_at               timestamptz default now()
);

alter table public.agent_client_messages enable row level security;

create index if not exists idx_agent_client_messages_pending
  on public.agent_client_messages (brokerage_id, proposed_at) where status = 'proposed';

comment on table public.agent_client_messages is
  'Governed client-facing messages proposed by managed agents (listing concierge, deal coordinator). Nothing reaches a seller/buyer without a human approving in the Command Center.';
