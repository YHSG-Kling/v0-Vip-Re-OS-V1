-- m479 — OVER-QUOTA AI IS SERVED AND BILLED, NOT REFUSED.
--
-- Owner ruling (verbatim): "ai is a platform covered and their tier plan
-- determines usage to bill them extra if goes over a quota." AI stays bundled
-- in the subscription; the tier sets the INCLUDED monthly token quota
-- (plan_limits.limit_value for ai_tokens_monthly — seeded by 1054); usage past
-- the included quota is SERVED and billed as overage at period close, instead
-- of the hard block lib/ai/fair-use.ts enforced until now.
--
-- WHAT THIS ADDS (and what it deliberately does not):
--   1. plan_limits gains per-tier overage TERMS: overage_allowed +
--      overage_rate_cents_per_1k. Defaults are OFF/0 for every metric on every
--      tier, so nothing changes behaviour except where terms are seeded below.
--   2. Terms are seeded on the four live (tier, 'ai_tokens_monthly') rows.
--      The rates are PLATFORM-CONFIGURABLE SEED VALUES — defensible starting
--      points (roughly $10–$20 per 1M tokens, comfortably above blended
--      gateway cost), tuned by the platform in plan_limits, never hardcoded
--      in app code.
--   3. ai_overage_invoices — a record of BILLING EVENTS, not usage. Usage has
--      ONE canon: usage_counters via the ledger (m474's period vocabulary).
--      Overage is DERIVED at read time as max(0, used − included_total)
--      (lib/billing/ai-overage.ts); this table only records the Stripe
--      writethrough outcome so a rerun of the period-close cron cannot
--      double-bill. UNIQUE(brokerage_id, period_start, metric) is the
--      idempotency key; a row may say 'billed' ONLY when it carries the
--      provider's invoice-item id (the outcome-reconciliation doctrine:
--      never mark billed without a provider result).
--
-- MEASURED before writing: plan_limits carries exactly four
-- (tier, 'ai_tokens_monthly') rows (1054's seed, ON CONFLICT-updated), and no
-- overage columns or ai_overage_invoices table exist under any spelling.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Overage terms on plan_limits — disabled by default.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.plan_limits
  add column if not exists overage_allowed boolean not null default false;
alter table public.plan_limits
  add column if not exists overage_rate_cents_per_1k integer not null default 0
    check (overage_rate_cents_per_1k >= 0);

comment on column public.plan_limits.overage_allowed is
  'When true, usage past limit_value (plus any approved ai_quota_overrides) is SERVED and billed as overage at period close instead of hard-blocked. Default false: overage is an explicit per-tier term, never an accident.';
comment on column public.plan_limits.overage_rate_cents_per_1k is
  'Overage price in integer CENTS per 1,000 units of the metric (for ai_tokens_monthly: cents per 1K tokens). Platform-configurable; the m479 seeds are starting values, not law. Meaningful only when overage_allowed.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Seed terms for the live tiers (ai_tokens_monthly only — every other
--    metric keeps the default OFF). SEED VALUES, platform-tunable:
--      solo_agent / team        2¢ per 1K tokens (= $20 per 1M)
--      brokerage / multi_location 1¢ per 1K tokens (= $10 per 1M, volume rate)
-- ─────────────────────────────────────────────────────────────────────────────
update public.plan_limits
set overage_allowed           = true,
    overage_rate_cents_per_1k = case plan_tier
                                  when 'solo_agent'     then 2
                                  when 'team'           then 2
                                  when 'brokerage'      then 1
                                  when 'multi_location' then 1
                                end,
    updated_at                = now()
where metric = 'ai_tokens_monthly'
  and plan_tier in ('solo_agent', 'team', 'brokerage', 'multi_location');

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. ai_overage_invoices — billing events only. period_start/period_end carry
--    the m474 canon (UTC half-open month); the CHECK pins the half-open shape
--    so an off-canon period can never mint a second idempotency identity.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.ai_overage_invoices (
  id                        uuid primary key default gen_random_uuid(),
  brokerage_id              uuid not null references public.brokerages(id) on delete cascade,
  metric                    text not null default 'ai_tokens_monthly'
                              check (metric = 'ai_tokens_monthly'),
  period_start              timestamptz not null,
  period_end                timestamptz not null,
  included_tokens           bigint  not null check (included_tokens >= 0),
  used_tokens               bigint  not null check (used_tokens >= 0),
  overage_tokens            bigint  not null check (overage_tokens > 0),
  overage_rate_cents_per_1k integer not null check (overage_rate_cents_per_1k > 0),
  amount_cents              integer not null check (amount_cents > 0),
  stripe_customer_id        text,
  stripe_invoice_item_id    text,
  -- pending = the idempotency claim is taken but the provider has not answered;
  -- billed  = the provider result is in hand. A pending row is a loud
  -- needs-reconciliation state for the cron, never silently re-billed.
  status                    text not null default 'pending'
                              check (status in ('pending', 'billed')),
  created_at                timestamptz not null default now(),
  billed_at                 timestamptz,
  -- The outcome-reconciliation doctrine, as a constraint: 'billed' without a
  -- provider invoice-item id is unrepresentable.
  constraint ai_overage_invoices_billed_has_provider_result
    check (status <> 'billed' or stripe_invoice_item_id is not null),
  -- m474 period canon: half-open UTC month.
  constraint ai_overage_invoices_period_is_half_open_month
    check (period_end = period_start + interval '1 mon'),
  -- THE idempotency key — one billing event per tenant per period per metric.
  constraint ai_overage_invoices_one_per_period
    unique (brokerage_id, period_start, metric)
);

comment on table public.ai_overage_invoices is
  'BILLING EVENTS for AI overage (m479) — NOT a usage accrual. Usage lives only in usage_counters; overage is derived at read time (lib/billing/ai-overage.ts) as max(0, used − included_total). One row per (brokerage, period, metric): the period-close cron claims the row as pending, calls Stripe, and marks billed only with the provider invoice-item id, so reruns cannot double-bill.';

create index if not exists idx_ai_overage_invoices_brokerage
  on public.ai_overage_invoices (brokerage_id, period_start desc);

alter table public.ai_overage_invoices enable row level security;

-- MONEY table: no tenant lane without a role (m433/m434). Reads for platform
-- staff and the tenant's finance admins (user_type OR grant — m466/m472,
-- via is_brokerage_finance_admin() paired with the tenant pin). NO
-- insert/update/delete policies: only the service-role cron writes billing
-- events.
drop policy if exists ai_overage_invoices_finance_select on public.ai_overage_invoices;
create policy ai_overage_invoices_finance_select on public.ai_overage_invoices
for select using (
  is_platform_admin()
  or (is_brokerage_finance_admin() and has_brokerage_access(brokerage_id))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Postconditions.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare n int;
begin
  -- The terms columns exist on plan_limits.
  select count(*) into n from information_schema.columns
  where table_schema = 'public' and table_name = 'plan_limits'
    and column_name in ('overage_allowed', 'overage_rate_cents_per_1k');
  if n <> 2 then
    raise exception 'm479: plan_limits overage term columns missing (found %/2)', n;
  end if;

  -- All four live tiers carry served-and-billed terms for ai_tokens_monthly.
  select count(*) into n from public.plan_limits
  where metric = 'ai_tokens_monthly'
    and plan_tier in ('solo_agent', 'team', 'brokerage', 'multi_location')
    and overage_allowed and overage_rate_cents_per_1k > 0;
  if n <> 4 then
    raise exception 'm479: expected 4 seeded ai_tokens_monthly overage terms, found %', n;
  end if;

  -- No OTHER metric had overage switched on by accident.
  select count(*) into n from public.plan_limits
  where metric <> 'ai_tokens_monthly' and overage_allowed;
  if n <> 0 then
    raise exception 'm479: % non-AI plan_limits row(s) unexpectedly overage-enabled', n;
  end if;

  -- The billing-event table exists with its idempotency key and the
  -- billed-needs-provider-result check, and RLS is on.
  select count(*) into n from pg_constraint
  where conrelid = 'public.ai_overage_invoices'::regclass
    and conname in ('ai_overage_invoices_one_per_period',
                    'ai_overage_invoices_billed_has_provider_result',
                    'ai_overage_invoices_period_is_half_open_month');
  if n <> 3 then
    raise exception 'm479: ai_overage_invoices constraints missing (found %/3)', n;
  end if;

  select count(*) into n from pg_class
  where oid = 'public.ai_overage_invoices'::regclass and relrowsecurity;
  if n <> 1 then
    raise exception 'm479: RLS not enabled on ai_overage_invoices';
  end if;

  -- Exactly the finance/platform SELECT policy — and no write policy at all
  -- (only the service role records billing events).
  select count(*) into n from pg_policies
  where schemaname = 'public' and tablename = 'ai_overage_invoices';
  if n <> 1 then
    raise exception 'm479: expected exactly 1 policy on ai_overage_invoices, found %', n;
  end if;
end $$;
