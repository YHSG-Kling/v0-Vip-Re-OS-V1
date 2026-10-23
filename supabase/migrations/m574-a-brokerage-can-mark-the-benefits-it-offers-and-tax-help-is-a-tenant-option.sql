-- m574 — Brokerage benefit offerings + tax assistance as a tenant option.
--
-- OWNER RULING (2026-08-27): "make sure that the brokerages have the ability in settings to mark
-- if they offer residual income and that this option is well built out. also if they offer medical
-- or retirement." and "tax assistance tech is an option for tenants built out."
--
-- RESIDUAL INCOME IS NOT A NEW COLUMN. A brokerage's residual-income offering IS agent-to-agent
-- revenue share, and that mark already exists: brokerages.revenue_share_enabled (m264). Adding an
-- "offers_residual_income" column beside it would be a second spelling of the same fact (§6) that
-- the waterfall and the revenue-share board could never be matched against. The settings surface
-- (app/actions/settings/revenue-share-setting.ts) presents revenue_share_enabled as the
-- residual-income offering; this migration adds only the two benefit marks that do NOT exist and
-- the tax-assistance enablement.
--
-- FAIL-CLOSED BY DEFAULT: not null default false — an unset mark means NOT OFFERED, never
-- "defaulted to offered". No backfill for medical/retirement: nothing in the live data can prove a
-- brokerage offers either, so nothing is invented.
--
-- Readers that make the marks mean something:
--   lib/recruiting/benefit-offerings.ts        (the one loader, fail-closed)
--   lib/recruiting/recruiting-pitch-kit.ts     (recruit-facing one-pager advertises offered benefits)
--   app/recruiting/[brokerageSlug]/page.tsx    (public careers landing)
--   lib/recruiting/retention-radar.ts          (save-play reminds the broker of the retention levers)

alter table public.brokerages
  add column if not exists offers_medical_benefits boolean not null default false;

alter table public.brokerages
  add column if not exists offers_retirement_benefits boolean not null default false;

-- TAX ASSISTANCE AS A TENANT OPTION. The tax tech (lib/finance/tax-planning.ts, the
-- quarterly-tax-concierge cron, the financials tax set-aside panel) previously ran for every
-- brokerage unconditionally. It is now a brokerage-level option gated at the feature entry points
-- (app/actions/tax-planning.ts, app/api/cron/quarterly-tax-concierge/route.ts via
-- lib/finance/tax-assistance.ts). NOT tier-entitled today — no tax feature key exists in
-- feature_flags; if one is added later the brokerage option COMPOSES with the tier (both must
-- allow), it does not replace it.
alter table public.brokerages
  add column if not exists tax_assistance_enabled boolean not null default false;

-- Backfill TRUE only where the feature is demonstrably IN USE — the m264 precedent (revenue share
-- was backfilled true only for brokerages with active revenue-share relationships, so existing
-- behavior didn't regress). An agent_tax_profile row exists only because an agent saved a tax
-- profile or recorded a quarterly payment; those tenants keep their working tax assistance.
update public.brokerages b
set tax_assistance_enabled = true
where exists (
  select 1 from public.agent_tax_profile p
  where p.brokerage_id = b.id
);

comment on column public.brokerages.offers_medical_benefits is
  'Broker-marked benefit offering: medical benefits available to agents. Fail-closed: false/unset = not offered. Set only via app/actions/settings/revenue-share-setting.ts (the one brokerage-offerings settings home).';
comment on column public.brokerages.offers_retirement_benefits is
  'Broker-marked benefit offering: retirement savings available to agents. Fail-closed: false/unset = not offered. Set only via app/actions/settings/revenue-share-setting.ts.';
comment on column public.brokerages.tax_assistance_enabled is
  'Tenant option: tax-assistance tech (1099 tax planning, quarterly-tax concierge) for this brokerage''s agents. Fail-closed at every gate (lib/finance/tax-assistance.ts). Composes with tier entitlement if a tax feature key is ever added — both must allow.';
