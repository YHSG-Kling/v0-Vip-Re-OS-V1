-- m224 — REGULATORY-CHANGE WATCHER observations table.
--
-- The natural pair to the encoded compliance gates (the 5-gate cascade in
-- lib/kernel/compliance.ts, FAIR_HOUSING_PATTERNS, state_protected_classes, the
-- BBA/authority gate). Those gates IMPLEMENT the law; when the law CHANGES, the
-- encoded rule can silently drift. The Regulatory-Change Watcher scans the gated
-- external-search rail (Tavily/Exa) for recent real-estate reg changes, matches each
-- to the OS surfaces it touches, and records ONE row per
-- (brokerage, change-signature, period): a real, sourced change that affects a gate.
--
-- WHY A NEW TABLE (justification, after verifying live schema):
--   · compliance_events is the OUTBOUND-CONTENT gate evaluation ledger (gate_name,
--     allowed, violations, actor_role, entity_type/contact). It records "did THIS
--     message pass the gates" — a per-message verdict. A reg-change observation is a
--     different fact: "the LAW behind a gate changed" — it carries a change_signature,
--     an effective_date, the affected_surfaces, an escalation timestamp, and a weekly
--     idempotency period. None of those fit compliance_events' columns, and folding
--     them in would corrupt the gate-verdict semantics + its stats aggregations.
--   · No reg_change / regulat% table exists in the live schema (verified).
--   · manager_signals carries the ESCALATION (the bus line) but is not an idempotent
--     observation store keyed by change-signature × period.
-- So a dedicated observations table, mirroring m223 style exactly (tenant-scoped,
-- unique idempotency index, honest defaults, RLS).
--
-- HONESTY is first-class (matches m223): a flagged change comes ONLY from a real
-- search hit (source/url carry provenance); effective_date is NULL unless a date is
-- literally present in the change text (never fabricated); severity_tier is a
-- CHECK-constrained vocabulary.

create table if not exists public.reg_change_observations (
  id               uuid primary key default gen_random_uuid(),
  brokerage_id     uuid not null references public.brokerages(id) on delete cascade,
  -- Deterministic fingerprint of the real change (FNV-1a over title + url) — the
  -- idempotency key component so the same change in the same period is recorded once.
  change_signature text not null,
  -- Idempotency PERIOD (ISO week, e.g. '2026-W24'). One row per change per week; a
  -- recurrence next week re-surfaces (weekly cadence matches the watcher cron).
  period           text not null,
  -- Provenance (NEVER fabricated): the real headline + source + url of the change.
  title            text not null,
  source           text not null,
  url              text,
  -- 'binding' | 'advisory' | 'informational' — classifyChangeSeverity output.
  severity_tier    text not null,
  -- Effective date PARSED LITERALLY from the change text; NULL when none present.
  effective_date   date,
  -- The OS surface ids this change touches (e.g. {tcpa-gate, fair-housing-patterns}).
  affected_surfaces text[] not null default '{}',
  -- Full per-surface detail (label, file to update, matched keywords) for the brief.
  surface_detail   jsonb not null default '[]'::jsonb,
  -- When the gated compliance/broker escalation was first sent (NULL until escalated).
  -- Idempotency for the ESCALATION: a rerun in the same period sees this set and
  -- escalates nothing new (re-flags as 'duplicate').
  escalated_at     timestamptz,
  observed_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),

  constraint reg_change_severity_chk
    check (severity_tier in ('binding', 'advisory', 'informational'))
);

-- Idempotency fence: at most ONE observation per (brokerage, change, period). A rerun
-- of the watcher in the same week UPSERTs this row rather than appending — the record
-- (and its escalation) is never inflated by reruns.
create unique index if not exists reg_change_obs_idem_key
  on public.reg_change_observations (brokerage_id, change_signature, period);

-- The read path scans a brokerage's recent observations cheaply (compliance dashboard).
create index if not exists reg_change_obs_brokerage_idx
  on public.reg_change_observations (brokerage_id, observed_at desc);

-- Tenant-isolation. Service-role (the watcher runner + cron) bypasses RLS; this denies
-- direct anon/authed cross-tenant reads, matching the app's posture (mirrors m223).
alter table public.reg_change_observations enable row level security;
