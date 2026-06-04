-- m143 — marketing-agent action ledger.
--
-- Wave 34. The agent's plan output now includes a `resolutions[]` array of
-- structured action proposals (retry stuck render, mark topic used,
-- defer campaign, stage newsletter draft, etc.). On human approval the
-- platform fires each action through a registered handler and records
-- the outcome here. The ledger gives:
--
--   · audit trail — who approved what, when, against which agent plan
--   · idempotency — second approval click doesn't double-execute
--   · observability — admin UI surfaces "marketing agent took these
--     N actions this week" without re-deriving from per-table writes
--
-- Status lifecycle:
--   proposed  — agent emitted, awaiting human approval
--   approved  — human clicked approve; handler queued
--   executing — handler is running
--   succeeded — handler returned ok
--   failed    — handler threw / returned !ok
--   skipped   — handler decided no-op (e.g. cooldown still active)

create table if not exists public.marketing_agent_actions (
  id                        uuid primary key default gen_random_uuid(),
  brokerage_id              uuid not null references public.brokerages(id) on delete cascade,
  managed_agent_session_id  uuid references public.managed_agent_sessions(id) on delete set null,
  action_type               text not null check (action_type in (
    'retry_listing_promo_render',
    'mark_topic_used',
    'defer_newsletter_campaign',
    'stage_newsletter_draft'
  )),
  /** Action payload — schema varies by action_type. The handlers validate
   *  per-shape; the table just stores the input verbatim for audit. */
  action_input              jsonb not null default '{}'::jsonb,
  status                    text not null default 'proposed' check (status in (
    'proposed','approved','executing','succeeded','failed','skipped'
  )),
  /** Free-text from the agent explaining WHY it's proposing this action.
   *  Surfaced in the admin approval UI so the human approver can decide
   *  with context. */
  rationale                 text,
  /** Handler return shape — error message OR success data (e.g. the new
   *  campaign_id when stage_newsletter_draft succeeds). */
  result                    jsonb,
  proposed_at               timestamptz not null default now(),
  approved_at               timestamptz,
  approved_by               uuid references public.users(id) on delete set null,
  executed_at               timestamptz
);

create index if not exists idx_marketing_agent_actions_session
  on public.marketing_agent_actions (managed_agent_session_id, proposed_at desc);
create index if not exists idx_marketing_agent_actions_brokerage_recent
  on public.marketing_agent_actions (brokerage_id, proposed_at desc);
create index if not exists idx_marketing_agent_actions_pending
  on public.marketing_agent_actions (brokerage_id, status, proposed_at desc)
  where status in ('proposed','approved','executing');

alter table public.marketing_agent_actions enable row level security;
create policy "service_role_full" on public.marketing_agent_actions
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
