-- m226 — DEAL-AUTOPSY observations table.
--
-- When a transaction reaches the terminal failure state (status='lost'), a
-- post-mortem autopsy classifies the failure reason from REAL transaction facts
-- (which contingency failed / survived, lender status, title issues, days-on-market,
-- the existing lost_category/lost_reason columns) and records ONE observation row
-- per transaction — the durable, idempotent audit record of WHY a deal fell through.
--
-- WHY A NEW TABLE (justified after verifying live schema):
--   · transactions.lost_category / lost_reason are free-text fields set by humans.
--     The autopsy is AI-CLASSIFIED from the contingency evidence and carries
--     confidence, evidence[], and the specific reason enum — a distinct fact.
--   · transaction_timeline records activity events but not a structured post-mortem.
--   · manager_signals carries the escalation BUS LINE but is not an idempotent
--     observation store keyed by transaction.
--   · No deal_autopsy / postmortem table exists in the live schema (verified).
-- So a dedicated observations table, mirroring m223/m224 style exactly
-- (tenant-scoped, unique idempotency index, CHECK-constrained vocab, RLS).
--
-- HONESTY is first-class: reason is only one of the 8 documented enum values,
-- confidence is 0.0–1.0 derived from real evidence strength, evidence[] carries
-- the specific column/table facts that drove the classification (never fabricated).
-- A missing evidence item makes the reason 'other', never a guess.

create table if not exists public.deal_autopsy_observations (
  id               uuid primary key default gen_random_uuid(),
  brokerage_id     uuid not null references public.brokerages(id) on delete cascade,
  -- The transaction this autopsy covers. ONE autopsy per transaction (unique index).
  -- Cascade so deleting a transaction clears its autopsy (simulator cleanup relies on this).
  transaction_id   uuid not null references public.transactions(id) on delete cascade,
  -- Terminal status at time of autopsy (captured from the real row, not assumed).
  terminal_status  text not null,

  -- ── Classifier output ──────────────────────────────────────────────────────
  -- The classified failure reason — 8 documented values, CHECK-constrained.
  --   'financing'        — lender/financing contingency failed or was never removed
  --   'inspection'       — inspection issues that weren't resolved / contingency live
  --   'appraisal'        — appraisal came in low (appraisal_value < purchase_price)
  --   'cold_feet'        — no contingency evidence; buyer/seller withdrew late
  --   'title'            — title issues present in title_escrow record
  --   'low_appraisal'    — explicit low appraisal variant (price gap > threshold)
  --   'competing_offer'  — lost_category/reason explicitly names competition
  --   'other'            — evidence insufficient to classify; recorded honestly
  failure_reason   text not null,
  -- Classification confidence 0.0–1.0: high (0.8+) when hard evidence drives the
  -- reason; medium (0.5–0.79) when suggestive; low (<0.5) when 'other'.
  confidence       numeric(3,2) not null,
  -- The specific evidence items (column names / values) that drove the classification.
  -- e.g. ['financing_contingency_removed_at IS NULL', 'lender.underwriting_status=declined']
  -- NEVER fabricated: only facts read from real rows.
  evidence         text[] not null default '{}',

  -- ── Deal facts captured at autopsy time ───────────────────────────────────
  -- Key numeric facts for trend analytics (what kinds of deals fail at what price?).
  purchase_price   numeric,
  days_under_contract integer,
  deal_type        text,

  -- ── Coaching + signal status ───────────────────────────────────────────────
  -- When the gated coaching message was proposed (NULL until done).
  coaching_proposed_at  timestamptz,
  -- When the manager signal was published (NULL until done).
  signal_published_at   timestamptz,

  observed_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),

  constraint deal_autopsy_reason_chk
    check (failure_reason in (
      'financing', 'inspection', 'appraisal', 'cold_feet',
      'title', 'low_appraisal', 'competing_offer', 'other'
    )),
  constraint deal_autopsy_confidence_chk
    check (confidence >= 0.0 and confidence <= 1.0)
);

-- Idempotency fence: at most ONE autopsy per transaction. A re-run on an already-
-- autopsied transaction is a no-op (runDealAutopsy checks this before classifying).
create unique index if not exists deal_autopsy_txn_key
  on public.deal_autopsy_observations (transaction_id);

-- Analytics: scan a brokerage's autopsies by reason + date for trend reporting.
create index if not exists deal_autopsy_brokerage_reason_idx
  on public.deal_autopsy_observations (brokerage_id, failure_reason, observed_at desc);

-- Tenant-isolation. Service-role (the autopsy runner + cron) bypasses RLS; this
-- denies direct anon/authed cross-tenant reads, matching the app's posture (mirrors m223/m224).
alter table public.deal_autopsy_observations enable row level security;
