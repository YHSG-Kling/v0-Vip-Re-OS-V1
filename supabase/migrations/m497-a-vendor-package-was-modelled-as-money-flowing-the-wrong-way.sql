-- m497 — A VENDOR PACKAGE WAS MODELLED AS MONEY FLOWING THE WRONG WAY
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE DEFECT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Owner ruling, verbatim:
--
--   "vendor packages are for brokerages to charge the vendor on a subscription
--    to the platform. vendors do bill the brokerages for jobs but not a monthly
--    subscription."
--
-- Two waves ago this repo shipped the exact opposite. `vendor_plans` was built
-- as A VENDOR'S OWN PRICE LIST (vendor_plans.vendor_id → vendor_marketplace_profiles,
-- policy vendor_plans_vendor_manage_own) and `vendor_subscriptions` as A
-- BROKERAGE BUYING ONE OF THOSE PLANS, monthly. That is money flowing
-- brokerage → vendor on a recurring cadence, and the ruling says that cadence
-- does not exist in this direction: a vendor bills a brokerage PER JOB
-- (vendor_invoices.billed_to='brokerage') and never monthly.
--
-- WHY IT LOOKED RIGHT. `vendor_subscriptions(brokerage_id, vendor_id, plan_id)`
-- is SYMMETRIC. Two party columns and nothing anywhere saying which one pays.
-- Whichever direction a reader arrives with, the table agrees with them. That is
-- the actual defect being fixed here — not one wrong row, but a shape that
-- cannot refuse the wrong reading.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THE LIVE DATABASE ALREADY SAID (measured, project hrvaqgvukzxfskkcrwbt)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The RLS on vendor_subscriptions has ALWAYS been:
--
--   vendor_subscriptions_tenant_insert  WITH CHECK is_platform_admin()
--          OR (has_brokerage_access(brokerage_id) AND is_brokerage_finance_admin())
--   vendor_subscriptions_tenant_update  same, USING + WITH CHECK
--   vendor_subscriptions_tenant_delete  same
--   vendor_subscriptions_tenant_select  can_read_tenant_financials()
--          OR (has_brokerage_access(brokerage_id) AND can_read_brokerage_books())
--          OR is_current_user_marketplace_vendor(vendor_id)
--
-- Only the BROKERAGE'S FINANCE ADMIN may write. The vendor may only READ. That
-- is a bill you ISSUE, not one you RECEIVE — and it is byte-for-byte the same
-- policy set that guards `vendor_invoices`, the brokerage's OWN ledger. The
-- database has been describing the corrected direction the whole time while the
-- application code above it described the opposite. This migration makes the
-- two agree, and then makes the wrong one unrepresentable.
--
-- ROW COUNTS BEFORE (measured, same project):
--   vendor_plans 0 · vendor_subscriptions 0 · vendor_transactions 0
--   vendor_marketplace_profiles 0 · vendor_invoices 0 · vendors 1 · brokerages 2
--
-- Nothing is being migrated, only re-pointed. No history is lost because none
-- exists — but the tables are KEPT AND REPOINTED rather than dropped and
-- rebuilt, which is this repo's merge-onto-the-survivor doctrine and also the
-- only way the FK from vendor_transactions.subscription_id survives.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE THREE MONEY PATHS AFTER THIS MIGRATION (lib/vendors/vendor-money-directions.ts)
-- ═══════════════════════════════════════════════════════════════════════════
--
--  1. VENDOR PACKAGE      vendor → brokerage, RECURRING
--        catalogue  vendor_plans          (owned by a BROKERAGE)
--        enrolment  vendor_subscriptions  (one VENDOR on one package)
--        billed     vendor_invoices, billed_to='vendor'
--
--  2. VENDOR JOB BILL     brokerage → vendor, PER JOB
--        vendor_invoices, billed_to='brokerage'.  UNCHANGED by this migration.
--
--  3. VENDOR PLATFORM TIER  vendor → platform, RECURRING
--        vendor_marketplace_profiles.subscription_tier / subscription_status.
--        PRE-EXISTING AND CORRECT.  UNCHANGED by this migration.
--
-- 1 and 3 are BOTH vendor-outbound and BOTH recurring. They differ in who
-- collects and in WHICH VENDOR ID SPACE identifies the payer. Keeping them
-- apart is why part C below moves vendor_subscriptions.vendor_id.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- A. vendor_plans — the catalogue changes OWNER, from a vendor to a brokerage
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `vendor_plans.vendor_id` is the column that genuinely encodes the wrong
-- direction, and there is no reading of it that survives the ruling: a package
-- the brokerage SELLS has no owning vendor, it is offered TO vendors generally.
-- Leaving it nullable-but-unused would be worse than removing it — a column
-- named vendor_id on a brokerage's price sheet is exactly the ambiguity that
-- produced the inversion.
--
-- The policy and the m490 unique index both reference the column, so Postgres
-- will refuse the DROP until they go. Both are re-created below against
-- brokerage_id, so the RULE each expressed survives; only its subject moves.

alter table public.vendor_plans
  add column if not exists brokerage_id uuid references public.brokerages(id) on delete cascade;

-- 0 rows live, so the backfill below is a no-op today. It is written anyway so
-- that a non-empty environment fails LOUDLY at the NOT NULL rather than
-- silently attaching every package to an arbitrary brokerage.
do $$
declare orphan_count integer;
begin
  select count(*) into orphan_count from public.vendor_plans where brokerage_id is null;
  if orphan_count > 0 then
    raise exception
      'm497: % vendor_plans rows have no brokerage_id. These were authored under the INVERTED model '
      '(a vendor''s own price list) and there is no mechanical way to say which brokerage now sells '
      'them — a guess here would attach one tenant''s price sheet to another. Decide per row, then '
      're-run.', orphan_count;
  end if;
end $$;

alter table public.vendor_plans alter column brokerage_id set not null;

-- The vendor-manages-own policy IS the inverted direction expressed in RLS.
drop policy if exists vendor_plans_vendor_manage_own    on public.vendor_plans;
drop policy if exists vendor_plans_authenticated_browse on public.vendor_plans;

-- m490 promised "one default plan per vendor". The promise survives; its
-- subject becomes the brokerage that sells the package.
drop index if exists public.vendor_plans_one_default_per_vendor;

alter table public.vendor_plans drop column if exists vendor_id;

create unique index if not exists vendor_plans_one_default_per_brokerage
  on public.vendor_plans (brokerage_id)
  where is_default and status = 'active';

comment on index public.vendor_plans_one_default_per_brokerage is
  'One default vendor package per BROKERAGE. Supersedes vendor_plans_one_default_per_vendor (m490), '
  'which keyed on vendor_id — a column m497 removed because a package is sold BY a brokerage, not BY '
  'a vendor. Partial on (is_default AND status=''active'') so archived packages do not hold the slot.';

create index if not exists idx_vendor_plans_brokerage on public.vendor_plans (brokerage_id);

-- A subscription must never point at another tenant's package. The composite FK
-- in part C needs a matching unique key to target.
alter table public.vendor_plans
  drop constraint if exists vendor_plans_id_brokerage_id_key;
alter table public.vendor_plans
  add constraint vendor_plans_id_brokerage_id_key unique (id, brokerage_id);

comment on table public.vendor_plans is
  'A BROKERAGE''S VENDOR PACKAGE CATALOGUE. Each row is a recurring package the brokerage SELLS TO '
  'VENDORS for access and placement in that brokerage''s marketplace. MONEY FLOWS VENDOR -> BROKERAGE. '
  'Collected through vendor_invoices with billed_to=''vendor'' (the one tenant->vendor ledger, shared '
  'with issueVendorCharge and premium placement) — this table is a PRICE SHEET, never a second '
  'billing rail. It was shipped in the OPPOSITE direction (a vendor''s own price list that brokerages '
  'subscribed to); m497 corrected it. See lib/vendors/vendor-money-directions.ts.';

comment on column public.vendor_plans.brokerage_id is
  'The SELLER — the brokerage that collects this package fee. Replaces vendor_id (m497), which named '
  'the wrong party entirely.';
comment on column public.vendor_plans.price_per_month is
  'What the VENDOR pays the brokerage each period. Never what a brokerage pays a vendor.';
comment on column public.vendor_plans.price_per_credit is
  'Overage price charged TO THE VENDOR beyond max_credits_per_month, same direction as price_per_month.';

-- RLS: the SELLER administers its own catalogue, on the same finance tier that
-- already guards vendor_subscriptions and vendor_invoices.
create policy vendor_plans_brokerage_manage_own on public.vendor_plans
  for all to authenticated
  using      (public.is_platform_admin()
              or (public.has_brokerage_access(brokerage_id) and public.is_brokerage_finance_admin()))
  with check (public.is_platform_admin()
              or (public.has_brokerage_access(brokerage_id) and public.is_brokerage_finance_admin()));

-- The browse policy was `TO authenticated USING (status = 'active')` — every
-- signed-in user of every tenant reading every brokerage's price sheet. Under
-- the inverted model that was merely wide; under the corrected one it leaks a
-- tenant's own pricing to its competitors. Narrowed to the two readers who have
-- a reason: staff of the selling brokerage, and a vendor shopping the
-- marketplace (who must be able to see a package before being enrolled in one).
--
-- public.has_vendor_seat() is used rather than an inline EXISTS over
-- user_role_assignments, and that is not style. A subquery inside an RLS policy
-- is evaluated UNDER THE CALLER'S OWN RLS on the referenced table, so an inline
-- read of user_role_assignments would be silently false for exactly the vendors
-- it is meant to admit. has_vendor_seat() already exists in this database,
-- STABLE SECURITY DEFINER with a pinned search_path, and its body is character
-- for character the predicate wanted here.
create policy vendor_plans_shopper_browse on public.vendor_plans
  for select to authenticated
  using (
    status = 'active'
    and (public.has_brokerage_access(brokerage_id) or public.has_vendor_seat())
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- B. vendor_subscriptions — the direction becomes a DATABASE FACT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Neither party column moves: brokerage_id and vendor_id were already the two
-- parties. What was missing is which of them PAYS. A single-valued CHECK is
-- deliberate — this is not a configuration knob. There is exactly one legal
-- direction, and an INSERT carrying any other literal fails in Postgres rather
-- than in review.

alter table public.vendor_subscriptions
  add column if not exists billing_direction text not null default 'vendor_pays_brokerage';

alter table public.vendor_subscriptions
  drop constraint if exists vendor_subscriptions_billing_direction_check;
alter table public.vendor_subscriptions
  add constraint vendor_subscriptions_billing_direction_check
  check (billing_direction = 'vendor_pays_brokerage');

comment on column public.vendor_subscriptions.billing_direction is
  'SINGLE-VALUED ON PURPOSE. A vendor package is always vendor -> brokerage. The CHECK admits one '
  'literal so the inverted direction that shipped two waves ago (brokerage pays vendor monthly) '
  'cannot be re-entered by a writer, a webhook, or a backfill. If a genuinely new direction is ever '
  'needed it belongs in a new path in lib/vendors/vendor-money-directions.ts and a deliberate '
  'widening here — never a quiet second literal.';

comment on table public.vendor_subscriptions is
  'ONE VENDOR''S ENROLMENT IN ONE BROKERAGE VENDOR PACKAGE. brokerage_id is the party that CHARGES; '
  'vendor_id is the party that PAYS; money flows VENDOR -> BROKERAGE every period. This is the '
  'ENTITLEMENT record — the amount is collected through vendor_invoices (billed_to=''vendor''), not '
  'here. It shipped meaning the reverse (a brokerage subscribing to a vendor''s plan); m497 corrected '
  'it. The live write RLS — brokerage finance admin only, vendor read-only — always described the '
  'corrected direction. See lib/vendors/vendor-money-directions.ts.';

comment on column public.vendor_subscriptions.brokerage_id is
  'The party that CHARGES (payee). Also the owner of plan_id''s package — enforced by the composite FK.';
comment on column public.vendor_subscriptions.credits_used_this_period is
  'Credits the VENDOR consumed against its package this period. Basis for an overage charge TO the '
  'vendor at price_per_credit — never a credit the brokerage owes anyone.';

-- ═══════════════════════════════════════════════════════════════════════════
-- C. vendor_subscriptions.vendor_id — the PAYER must be the party the per-job
--    ledger already bills, or the two money paths can never be reconciled
-- ═══════════════════════════════════════════════════════════════════════════
--
-- vendor_id FK'd `vendor_marketplace_profiles(id)` — the PLATFORM-level
-- marketplace seller, which is also the id space of PATH 3 (the vendor's own
-- platform tier) and which carries no brokerage at all.
--
-- Every other brokerage<->vendor money artefact in this tree runs on
-- `vendors(id)`, the brokerage-scoped bench: vendor_invoices.vendor_id,
-- issueVendorCharge (verifyVendorInCallerBrokerage), premium placement, W-9s,
-- bookings, and the vendor PORTAL itself (canonical linkage
-- user_role_assignments.vendor_id → vendors.id).
--
-- m440 established that the two id spaces are DISJOINT and must never be
-- substituted for one another. That is precisely why this must move rather than
-- be left alone: with the payer in the marketplace-profile space, "what does
-- this vendor owe us" would have one answer for its package and a different one
-- for its jobs, on two different vendor identities, with no join between them.
-- An ambiguous ledger is worse than a missing feature.
--
-- Safe today: 0 rows, so no value is being re-interpreted.

do $$
declare row_count integer;
begin
  select count(*) into row_count from public.vendor_subscriptions;
  if row_count > 0 then
    raise exception
      'm497: vendor_subscriptions holds % rows whose vendor_id is in the vendor_marketplace_profiles '
      'id space. Re-pointing the FK would silently re-interpret each one as a DIFFERENT vendor '
      '(m440: the two id spaces are disjoint). Map them by hand first.', row_count;
  end if;
end $$;

alter table public.vendor_subscriptions
  drop constraint if exists vendor_subscriptions_vendor_id_fkey;
alter table public.vendor_subscriptions
  add constraint vendor_subscriptions_vendor_id_fkey
  foreign key (vendor_id) references public.vendors(id) on delete cascade;

comment on column public.vendor_subscriptions.vendor_id is
  'The party that PAYS. A public.vendors(id) — the BROKERAGE-SCOPED bench row, the same party '
  'vendor_invoices.vendor_id bills, so a vendor''s recurring package fee and its per-job invoices '
  'reconcile on ONE identity. NOT vendor_marketplace_profiles(id): that is the platform-tier id '
  'space (m440 — the two are disjoint and must never be substituted).';

-- A cross-tenant enrolment becomes unrepresentable rather than merely refused
-- by app code: the package's brokerage and the enrolment's brokerage are now the
-- same column pair.
alter table public.vendor_subscriptions
  drop constraint if exists vendor_subscriptions_plan_in_same_brokerage_fkey;
alter table public.vendor_subscriptions
  add constraint vendor_subscriptions_plan_in_same_brokerage_fkey
  foreign key (plan_id, brokerage_id)
  references public.vendor_plans (id, brokerage_id) on delete restrict;

comment on constraint vendor_subscriptions_plan_in_same_brokerage_fkey on public.vendor_subscriptions is
  'The package a vendor is enrolled in must belong to the brokerage doing the charging. Composite, so '
  'the tenant boundary holds in storage and not only in the writer. ON DELETE RESTRICT keeps m490''s '
  'rule that a package someone pays for can never be deleted — archive it instead.';

-- The read grant must follow the FK. is_current_user_marketplace_vendor()
-- compares a vendors.id to a vendor_marketplace_profiles.id after part C and is
-- therefore false for every row that will ever exist — m440 named this exact
-- trap. is_current_user_vendor() is the predicate for the vendors(id) space.
drop policy if exists vendor_subscriptions_tenant_select on public.vendor_subscriptions;
create policy vendor_subscriptions_tenant_select on public.vendor_subscriptions
  for select to authenticated
  using (
    public.can_read_tenant_financials()
    or (public.has_brokerage_access(brokerage_id) and public.can_read_brokerage_books())
    or public.is_current_user_vendor(vendor_id)
  );

-- The write policies are UNCHANGED and deliberately so: brokerage finance admin
-- only. Under the corrected direction that is the seller issuing the charge,
-- which is what it should have meant all along. Restated here as a comment so a
-- future reader does not "fix" it toward vendor self-service.
comment on policy vendor_subscriptions_tenant_select on public.vendor_subscriptions is
  'The vendor may READ what it is being charged; only the charging brokerage''s finance admin may '
  'WRITE it (see vendor_subscriptions_tenant_insert/update/delete, unchanged by m497). A vendor '
  'enrolling itself would be the payer authoring its own bill.';

-- ═══════════════════════════════════════════════════════════════════════════
-- D. vendor_transactions — NAMED, NOT WIRED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Deliberately untouched. It has ZERO rows and, measured across app/ and lib/,
-- ZERO readers and ZERO writers — it is a second billing rail that was never
-- built, and building one now would give "what does this vendor owe us" the two
-- answers part C exists to prevent. Its vendor_id still points at
-- vendor_marketplace_profiles, which after part C is a DIFFERENT id space from
-- vendor_subscriptions.vendor_id. Comment rather than change, so the hazard is
-- written down where the next reader will meet it.

comment on table public.vendor_transactions is
  'DORMANT — 0 rows, no reader, no writer anywhere in app/ or lib/ (measured at m497). Do NOT use it '
  'to record vendor package money: vendor_invoices (billed_to=''vendor'') is the ONE tenant->vendor '
  'ledger, shared with issueVendorCharge and premium placement. Note also that vendor_id here is a '
  'vendor_marketplace_profiles(id) while vendor_subscriptions.vendor_id is a vendors(id) — disjoint '
  'spaces (m440) — so subscription_id cannot be joined through vendor_id. Repoint this table before '
  'wiring it, or retire it.';

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT IS NOT DONE HERE, named so it is not mistaken for covered
-- ═══════════════════════════════════════════════════════════════════════════
--
-- · No automatic invoice is minted when a period rolls over. Enrolment records
--   the arrangement; raising the charge stays the deliberate act it already is
--   for premium placement and issueVendorCharge. A recurring biller that mints
--   money on a cron is a separate decision with an owner in it.
-- · vendor_plans.features_json, trial_days, billing_cycle, max_credits_per_month
--   keep their live CHECKs verbatim — the direction changed, the field rules did
--   not, and lib/vendors/vendor-validators.ts still matches them field for field.
-- · vendor_marketplace_profiles is untouched. PATH 3 (vendor pays the platform)
--   was already correct.
