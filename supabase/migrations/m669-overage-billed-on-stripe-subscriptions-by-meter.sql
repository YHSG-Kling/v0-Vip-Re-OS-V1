-- ── APPLIED LIVE 2026-09-28 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
--
-- m669 — OVERAGE CAN BE CHARGED ON THE STRIPE BILLING SUBSCRIPTION (wave 87, lane 87C).
--
-- Owner, verbatim 2026-09-28: "make video overage rate and option that the
-- platform could charge on stripe billing subscriptions."
--
-- Live state read 2026-09-28 (project hrvaqgvukzxfskkcrwbt, execute_sql):
--   plan_limits (68 rows) has NO stripe_* column. Overage terms:
--     video_minutes      solo_agent 30 / team 150 / brokerage 300 min, overage ON
--                        at 50000 ¢/1K min ($0.50/min, m666); multi_location -1, OFF.
--     ai_tokens_monthly  2M / 10M / 30M / 100M, overage ON at 2 / 2 / 1 / 1 ¢/1K.
--   ai_overage_invoices: 0 rows. CHECK ai_overage_invoices_billed_has_provider_result
--     = (status <> 'billed' OR stripe_invoice_item_id IS NOT NULL).
--   subscriptions: 0 rows with a stripe_subscription_id.
--
-- Stripe's current usage-based model is Billing METERS + meter EVENTS with a
-- metered price (recurring.usage_type = metered, recurring.meter) as an item on
-- the subscription; legacy usage records were removed in API 2025-03-31.basil
-- (the repo pins 2026-02-25.clover). lib/billing/stripe-overage-meter.ts
-- publishes the meter + a per-tier metered price when platform staff ask, and
-- the period-close writethrough (lib/billing/ai-overage.ts) reports the claimed
-- overage as ONE meter event instead of an invoice item.
--
-- This migration:
--   1. plan_limits gains the tier's published Stripe link — stripe_meter_id,
--      stripe_metered_price_id, and stripe_metered_rate_cents_per_1k (the rate
--      the price was published at; a later rate edit makes the price STALE and
--      the run falls back to the invoice item until it is republished). All
--      three NULL (= nothing published) on every row: NO PRICE IS SET HERE —
--      prices stay the platform's configured overage rates.
--   2. ai_overage_invoices records which channel billed the row: billing_channel
--      ('invoice_item' default | 'meter_event') + stripe_meter_event_identifier;
--      the provider-result CHECK is widened so 'billed' still requires the
--      channel's OWN provider result (the invoice-item id, or the meter-event
--      identifier) — billed without a provider result stays unrepresentable.

begin;

alter table public.plan_limits
  add column if not exists stripe_meter_id text,
  add column if not exists stripe_metered_price_id text,
  add column if not exists stripe_metered_rate_cents_per_1k integer;

alter table public.plan_limits
  drop constraint if exists plan_limits_stripe_metered_link_complete;
alter table public.plan_limits
  add constraint plan_limits_stripe_metered_link_complete
  check (
    stripe_metered_price_id is null
    or (stripe_meter_id is not null and stripe_metered_rate_cents_per_1k is not null and stripe_metered_rate_cents_per_1k > 0)
  );

comment on column public.plan_limits.stripe_meter_id is
  'm669: the Stripe Billing Meter this metric''s overage is reported on (one meter per metric, shared by every tier). NULL = not published.';
comment on column public.plan_limits.stripe_metered_price_id is
  'm669: the tier''s metered Stripe price on that meter (usage_type=metered), attached as an item on each tenant subscription. NULL = the overage bills by invoice item.';
comment on column public.plan_limits.stripe_metered_rate_cents_per_1k is
  'm669: the overage_rate_cents_per_1k the metered price was published at. When it differs from overage_rate_cents_per_1k the price is stale and billing falls back to the invoice item until republished.';

alter table public.ai_overage_invoices
  add column if not exists billing_channel text not null default 'invoice_item',
  add column if not exists stripe_meter_event_identifier text;

alter table public.ai_overage_invoices
  drop constraint if exists ai_overage_invoices_billing_channel_check;
alter table public.ai_overage_invoices
  add constraint ai_overage_invoices_billing_channel_check
  check (billing_channel in ('invoice_item', 'meter_event'));

alter table public.ai_overage_invoices
  drop constraint if exists ai_overage_invoices_billed_has_provider_result;
alter table public.ai_overage_invoices
  add constraint ai_overage_invoices_billed_has_provider_result
  check (
    status <> 'billed'
    or (billing_channel = 'invoice_item' and stripe_invoice_item_id is not null)
    or (billing_channel = 'meter_event' and stripe_meter_event_identifier is not null)
  );

-- Postconditions (measured, m479/m666 style).
do $$
declare
  n int;
  def text;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'plan_limits'
     and column_name in ('stripe_meter_id', 'stripe_metered_price_id', 'stripe_metered_rate_cents_per_1k');
  if n <> 3 then
    raise exception 'm669 postcondition: plan_limits has % of the 3 Stripe link columns', n;
  end if;

  select count(*) into n from public.plan_limits where stripe_metered_price_id is not null;
  if n <> 0 then
    raise exception 'm669 postcondition: % plan_limits row(s) already carry a metered price — this migration publishes nothing', n;
  end if;

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'ai_overage_invoices'
     and column_name in ('billing_channel', 'stripe_meter_event_identifier');
  if n <> 2 then
    raise exception 'm669 postcondition: ai_overage_invoices has % of the 2 channel columns', n;
  end if;

  select pg_get_constraintdef(c.oid) into def
    from pg_constraint c
   where c.conrelid = 'public.ai_overage_invoices'::regclass
     and c.conname = 'ai_overage_invoices_billed_has_provider_result';
  if def is null or position('stripe_invoice_item_id' in def) = 0 or position('stripe_meter_event_identifier' in def) = 0 then
    raise exception 'm669 postcondition: billed-has-provider-result must name both provider results (%)', def;
  end if;

  select count(*) into n from public.ai_overage_invoices where billing_channel <> 'invoice_item';
  if n <> 0 then
    raise exception 'm669 postcondition: % existing ledger row(s) were not defaulted to invoice_item', n;
  end if;
end $$;

commit;
