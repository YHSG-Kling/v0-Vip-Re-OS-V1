-- m254-buyer-move-services.sql
--
-- BUYER MOVE SERVICES — the post-contract move-in concierge, folded into the Deal Coordinator. When a
-- BUYER-side deal enters CLOSING_PREP the buyer has a second job (turn on utilities, change address,
-- book movers) that has nothing to do with the contract but sinks the move-in experience — and the
-- referral — when it slips. ONE table holds the dated move-in checklist (tasks jsonb) and the service
-- mode decision. No parallel task system: the checklist lives on the case; deadlines/messages reuse the
-- existing deal infra. Two modes:
--   • contact_assisted_guided_diy — guide the buyer through each task IN-APP (default, always on).
--   • handoff                     — hand utility setup to the Utility Connect partner (EXTERNAL).
-- The handoff RECOMMENDATION always computes (recommended_mode); its EXECUTION is gated behind a feature
-- flag (FEATURES.BUYER_MOVE_UTILITY_CONNECT) until the partner code + creds exist — the handoff jsonb
-- and the external push stay dormant while the flag is off.

create table if not exists buyer_move_cases (
  id                     uuid primary key default gen_random_uuid(),
  brokerage_id           uuid not null,
  transaction_id         uuid not null unique,
  buyer_contact_id       uuid,
  agent_id               uuid,
  service_mode           text not null default 'contact_assisted_guided_diy'
                           check (service_mode in ('contact_assisted_guided_diy','handoff')),
  recommended_mode       text not null default 'contact_assisted_guided_diy'
                           check (recommended_mode in ('contact_assisted_guided_diy','handoff')),
  case_status            text not null default 'active'
                           check (case_status in ('draft','active','blocked','handoff_started','completed')),
  closing_date           date,
  move_in_date           date,
  friction_score         numeric not null default 0,
  buyer_preference_notes text,
  tasks                  jsonb not null default '[]'::jsonb,
  handoff                jsonb,  -- Utility Connect payload/receipt — stays null until the flag is on
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists idx_buyer_move_cases_txn   on buyer_move_cases (transaction_id);
create index if not exists idx_buyer_move_cases_agent on buyer_move_cases (agent_id);

comment on table buyer_move_cases is
  'Post-contract buyer move-in concierge (Deal Coordinator). tasks jsonb = the dated move-in checklist; service_mode/recommended_mode = guided-DIY vs Utility Connect handoff (handoff EXECUTION is feature-flagged off until partner creds exist).';
