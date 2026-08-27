-- m571-the-vendor-marketplace-should-not-have-any-default.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- WRITTEN, NOT APPLIED — lanes write migrations; only the integrator applies
-- them (CLAUDE.md §3). After applying, regenerate the schema caches if any
-- generator ever grows a defaults column (today none records defaults).
--
-- Owner ruling, verbatim (2026-08-27): "the vendor marketplace should not have
-- any default."
--
-- WHAT THE LIVE CATALOG HELD (queried 2026-08-27, project hrvaqgvukzxfskkcrwbt,
-- information_schema.columns on public.vendor_marketplace_profiles — table held
-- 0 rows, so no backfill question arises):
--
--   subscription_status            NOT NULL DEFAULT 'active'   ← the expensive one
--   subscription_tier              NOT NULL DEFAULT 'basic'
--   status                         DEFAULT 'pending'
--   payout_method                  DEFAULT 'stripe'
--   stripe_onboarding_complete     DEFAULT false
--   revenue_share_percent          DEFAULT 0
--   default_revenue_share_percent  DEFAULT 20
--
-- Why 'active' is not a harmless default: 'active' is in
-- PLATFORM_USE_PAYING_STATUSES (lib/vendors/vendor-platform-identity.ts), so a
-- row inserted without an explicit subscription_status was born ALREADY PAYING
-- the platform — which both exempts its brokerages from platform-use charges
-- they owe (the m549 gate) and misstates the vendor's own billing. A tier
-- defaulted to 'basic' likewise asserts a plan nobody chose.
--
-- FAIL CLOSED (§4): dropping the default on the two NOT NULL columns means an
-- insert that omits them is REFUSED ENTIRELY by Postgres — "nobody said" no
-- longer renders as "said basic/active". Verified writers (stripped-source scan
-- of every .from("vendor_marketplace_profiles") call, 2026-08-27):
--
--   · app/actions/vendor-invite.ts:429 (the ONE app insert) — sets user_id,
--     company_name, category, support_email, subscription_tier 'basic',
--     subscription_status 'canceled', status 'pending' EXPLICITLY.
--   · scripts/vendor-subscription-simulator.ts:114 (test insert) — sets
--     user_id, company_name, category, status, subscription_tier,
--     subscription_status explicitly.
--   · No seed writes this table; no trigger inserts rows (the only trigger
--     touches updated_at).
--
-- Defaults are dropped on EVERY business column, not just the seven that had
-- one — a no-op DROP DEFAULT costs nothing and pins the ruling for the whole
-- row shape. KEPT deliberately: id (gen_random_uuid()) and created_at /
-- updated_at (now()) — machine bookkeeping, not business values; the owner's
-- ruling is about the marketplace's money- and state-bearing facts.

alter table public.vendor_marketplace_profiles
  alter column user_id                       drop default,
  alter column company_name                  drop default,
  alter column description                   drop default,
  alter column category                      drop default,
  alter column website                       drop default,
  alter column logo_url                      drop default,
  alter column api_endpoint                  drop default,
  alter column api_key_encrypted             drop default,
  alter column default_revenue_share_percent drop default,
  alter column support_email                 drop default,
  alter column support_phone                 drop default,
  alter column status                        drop default,
  alter column stripe_account_id             drop default,
  alter column stripe_onboarding_complete    drop default,
  alter column payout_method                 drop default,
  alter column revenue_share_percent         drop default,
  alter column api_key                       drop default,
  alter column subscription_tier             drop default,
  alter column subscription_status           drop default,
  alter column stripe_customer_id            drop default,
  alter column stripe_subscription_id        drop default;

-- SELF-CHECK (assert the RULE, derive the number — §2): after this runs, no
-- column of the table outside the bookkeeping allowlist may carry a default.
-- A future migration that re-adds one will not trip this (it ran already), but
-- re-running this file must always pass, and the guard layer
-- (scripts/vendor-subscription-simulator.ts, no-default section) re-derives the
-- covered column list from the schema snapshot on every run.
do $$
declare
  offender record;
begin
  for offender in
    select column_name, column_default
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'vendor_marketplace_profiles'
      and column_default is not null
      and column_name not in ('id', 'created_at', 'updated_at')
  loop
    raise exception 'vendor_marketplace_profiles.% still defaults to % — the owner ruled the marketplace has no defaults',
      offender.column_name, offender.column_default;
  end loop;
end $$;
