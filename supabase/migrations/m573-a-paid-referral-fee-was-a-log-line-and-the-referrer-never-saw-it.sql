-- m573-a-paid-referral-fee-was-a-log-line-and-the-referrer-never-saw-it.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- SUBSCRIBER-REFERRAL PAYOUTS: POSTED (a real ledger) + the fee TERMS' one home.
--
-- WRITTEN 2026-08-27, NOT APPLIED (integrator applies; lanes only write).
-- After applying: regenerate the schema caches (schema-snapshot.ts,
-- schema-fk-map.ts, live-tables.ts) AND the vocabulary cache
-- (check-vocabularies.ts) — this migration adds CHECK constraints, and
-- check-vocabulary-guard can only hold code and database in agreement if the
-- cache absorbs them (CLAUDE.md §3).
--
-- THE GAP (owner ruling: "make sure referral payouts are posted and received
-- by the recipient"): the subscriber-referral rail (platform_prospects.source
-- = 'referral:<who>' → converted_brokerage_id → MRR) recorded a payment as a
-- superadmin_audit_log line (action 'referral_fee.paid') and READ the "paid"
-- state BACK from that log. An append-only audit line is a trail, not a POSTED
-- payout: it has no recipient, no state, no idempotency key, and NO surface
-- the referrer can ever see. Meanwhile the fee rate lived as a code constant
-- (lib/platform/subscriber-referrals.ts REFERRAL_FEE_PERCENT = 10) because
-- platform_settings had no column for it — the module's own header says
-- "when that column lands, swap the constant for a read".
--
-- WHAT THIS MIGRATION ADDS:
--
--   1) platform_settings.referral_fee_percent — the referral-fee TERMS' ONE
--      home (§6), on the same singleton row the platform god-switches live on
--      (lib/platform/platform-controls.ts reads the oldest row). Code reads it
--      through lib/platform/referral-payouts.ts::getReferralFeeTerms, which
--      falls back to the constant until this is applied.
--
--   2) referral_payouts — the POSTED ledger. One row per (prospect, period):
--      UNIQUE(prospect_id, period) makes posting idempotent by construction
--      (the affiliate rail's proven idiom — affiliate_commission_events
--      UNIQUE(referral_id, period)). recipient_brokerage_id is resolved at
--      post time from the referrer string's email → users.email →
--      users.brokerage_id (a TENANT referrer — the normal SaaS shape, credited
--      against their own subscription); recipient_email keeps the parsed
--      address for NON-tenant referrers, honestly recorded as the half whose
--      pay-out rail (external transfer) is not built yet.
--      status: 'posted' → 'received' (the recipient's own billing surface
--      acknowledges receipt — RECEIVED is the recipient seeing + confirming,
--      not the platform asserting) or 'void'.
--
-- WHAT STAYS: superadmin_audit_log remains the AUDIT TRAIL (new trail action
-- 'referral_payout.posted'); legacy 'referral_fee.paid' lines remain readable
-- history for payments recorded before this ledger existed. The ledger is the
-- money record; the log is who did it, when, from where.
--
-- FK posture: prospect_id ON DELETE RESTRICT — a money ledger must not vanish
-- because a funnel row was tidied; deleting a prospect with posted payouts is
-- a deliberate act that must first adjudicate the money. recipient/actor FKs
-- ON DELETE SET NULL — losing a user row must never delete payout history.
--
-- RLS: enabled, NO policies — service-role only, the same posture as
-- platform_config_snapshots and every platform_* control-plane table (tenant
-- reads go through the session-gated server action, never direct RLS).

-- 1) Referral-fee terms: ONE home, on the platform_settings singleton.
alter table public.platform_settings
  add column if not exists referral_fee_percent numeric not null default 10;

alter table public.platform_settings
  drop constraint if exists platform_settings_referral_fee_percent_check;
alter table public.platform_settings
  add constraint platform_settings_referral_fee_percent_check
  check (referral_fee_percent >= 0 and referral_fee_percent <= 50);

comment on column public.platform_settings.referral_fee_percent is
  'Subscriber-referral fee as % of the referred tenant''s MRR. The ONE home of the terms (CLAUDE.md §6); lib/platform/referral-payouts.ts::getReferralFeeTerms reads it (falls back to the code default when unset).';

-- 2) The POSTED ledger.
create table if not exists public.referral_payouts (
  id                     uuid primary key default gen_random_uuid(),
  prospect_id            uuid not null references public.platform_prospects(id) on delete restrict,
  -- The referrer exactly as recorded on the prospect source at post time
  -- ("Jane Doe <jane@x.com>") — the ledger stays readable even if the
  -- prospect row's source is later edited.
  referrer               text not null,
  -- Resolved recipient: a TENANT referrer (users.email match → their
  -- brokerage) or, for a non-tenant referrer, the parsed email only.
  recipient_brokerage_id uuid references public.brokerages(id) on delete set null,
  recipient_email        text,
  amount_cents           integer not null check (amount_cents > 0),
  -- The terms used for THIS posting, denormalized so history survives a
  -- later terms change.
  fee_percent            numeric not null check (fee_percent >= 0 and fee_percent <= 100),
  -- Billing period the fee is for ('YYYY-MM') — the idempotency grain.
  period                 text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status                 text not null default 'posted' check (status in ('posted', 'received', 'void')),
  note                   text,
  posted_by              uuid references public.users(id) on delete set null,
  posted_at              timestamptz not null default now(),
  received_at            timestamptz,
  received_by            uuid references public.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- IDEMPOTENT POSTING: one payout per referral per period. A double-click,
  -- a retried request, or two staffers posting the same month land on 23505
  -- and are reported as "already posted", never as a second payment.
  constraint referral_payouts_prospect_period_key unique (prospect_id, period)
);

create index if not exists idx_referral_payouts_recipient_brokerage
  on public.referral_payouts (recipient_brokerage_id)
  where recipient_brokerage_id is not null;
create index if not exists idx_referral_payouts_prospect
  on public.referral_payouts (prospect_id);

alter table public.referral_payouts enable row level security;
-- No policies on purpose: service-role only (deny-all to users). The
-- recipient surface reads through the session-gated action
-- app/actions/admin/referral-earnings.ts, which scopes to the SESSION tenant.

comment on table public.referral_payouts is
  'Subscriber-referral fee POSTED ledger — one row per (prospect, period). Written by app/actions/superadmin/subscriber-referrals.ts::markReferralFeePaidAction via lib/platform/referral-payouts.ts; read back by the superadmin growth card and by the recipient tenant''s billing surface (RECEIVED = status flip by the recipient). superadmin_audit_log stays the audit trail, not the ledger.';
