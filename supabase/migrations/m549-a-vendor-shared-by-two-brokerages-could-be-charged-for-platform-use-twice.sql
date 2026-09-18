-- m549 — A VENDOR SHARED BY TWO BROKERAGES COULD BE CHARGED FOR PLATFORM USE TWICE
-- =============================================================================
--
-- OWNER RULING, verbatim:
--
--   "vendors whcih include title companies and lenders can be used by other
--    brokerages so if a vendor is already on the platform, the brokerage/team/
--    agent can't charge them for platform use only access to their contacts."
--
-- TWO HALVES. (a) A VENDOR IS SHARED — a title company or lender is used by more
-- than one brokerage. (b) A VENDOR ALREADY PAYING FOR PLATFORM USE MUST NOT BE
-- CHARGED FOR IT AGAIN; the second tenant gets CONTACT ACCESS ONLY. A second
-- platform-use invoice on the same vendor is a wrong invoice.
--
-- ── WHAT THE DATABASE COULD AND COULD NOT SAY BEFORE THIS ────────────────────
--
-- `vendors.brokerage_id` is a TENANT BENCH ANCHOR and it is correct: live RLS is
--   SELECT (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())
--   INSERT/UPDATE/DELETE (brokerage_id = current_user_brokerage_id())
-- so one tenant's bench row is invisible to another tenant, and the row carries
-- that tenant's own notes, rating, placement flags, access_level and attribution,
-- and parents that tenant's assignments, invoices, bookings and subscriptions.
-- Merging two brokerages' rows onto one survivor would fuse two tenants' books.
-- So the rows are NOT duplicates to collapse.
--
-- WHAT WAS MISSING was any way to say that two bench rows are THE SAME REAL
-- COMPANY. Measured before this migration:
--   · no unique on vendors(name), no cross-tenant key of any kind;
--   · vendor-verification.ts dedupes only WITHIN one brokerage, so a cross-tenant
--     duplicate of one title company is invisible by design;
--   · the only join to the platform identity, user_role_assignments.vendor_id, is
--     1:1 BY CONSTRUCTION — acceptVendorInviteAction deletes any prior vendor
--     assignment before inserting and hard-refuses a vendor user already tied to
--     another brokerage — so it can never express half (a).
-- The platform therefore could not even ASK whether a vendor already pays, which
-- is why nothing was checking: not a forgotten check, an unaskable question.
--
-- ── THE SURVIVOR ALREADY EXISTED ─────────────────────────────────────────────
--
-- No new vendor table and no new link table. `vendor_marketplace_profiles` is
-- already the platform-level vendor: UNIQUE on company_name, NO brokerage_id, and
-- it carries subscription_tier / subscription_status / stripe_customer_id /
-- stripe_subscription_id — it IS the "vendor pays the platform" fact
-- (lib/vendors/vendor-money-directions.ts :: VENDOR_PLATFORM_TIER). This migration
-- adds the LINK to it, and the many-to-many is then the bench itself:
--   SELECT brokerage_id FROM vendors WHERE platform_vendor_id = $1
-- so no third spelling of "which brokerages use this vendor" is introduced.
--
-- ── AND THE RULE IS PUT IN THE DATABASE, NOT ONLY IN THE APP ─────────────────
--
-- lib/vendors/vendor-platform-identity.ts enforces (b) on all three application
-- charge lanes. A rule that lives only there is one a future writer re-opens by
-- adding a fourth lane, exactly as m497 records happening to the money DIRECTION.
-- The trigger below makes the second platform-use charge UNREPRESENTABLE.
--
-- APPLICATION STATUS: APPLIED 2026-08-24 to project hrvaqgvukzxfskkcrwbt.
--   Live two-sided controls were run against the applied schema and their fixtures
--   removed; the results are in the lane report. No assertion anywhere is pinned to
--   the words of this line (CLAUDE.md §2 — do not pin an assertion to a waypoint):
--   scripts/vendor-platform-use-double-charge-simulator.ts asks the DATABASE
--   whether the column, the function and the triggers are there, and reports the
--   pre-migration shape honestly where they are not.
--
--   INTEGRATOR FOLLOW-UP (CLAUDE.md §3): this adds a COLUMN and an FK, so the
--   generated schema caches drift until regenerated with credentials —
--   `npm run schema:regen`. Exactly two entries move:
--     scripts/schema-snapshot.ts   vendors[] gains "platform_vendor_id"
--     scripts/schema-fk-map.ts     "vendors" gains
--                                  "platform_vendor_id": "vendor_marketplace_profiles"
--   Both files are MACHINE-WRITTEN with a body-sha256 stamp and were deliberately
--   NOT hand-edited here. No CHECK constraint is added, so the vocabulary cache is
--   unaffected. Until the regen runs, `npm run test:schema-drift` reports 2
--   findings against lib/vendors/vendor-platform-identity.ts — the CACHE is stale,
--   the code is correct, and the column is live.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE LINK. Nullable on purpose: a bench row for a company that has never
--    taken a platform account has no platform identity, and that is a true state,
--    not a missing one. ON DELETE SET NULL — losing the platform account must not
--    delete a tenant's bench row or its invoices.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.vendors
  add column if not exists platform_vendor_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'vendors_platform_vendor_id_fkey'
  ) then
    alter table public.vendors
      add constraint vendors_platform_vendor_id_fkey
      foreign key (platform_vendor_id)
      references public.vendor_marketplace_profiles(id)
      on delete set null;
  end if;
end $$;

comment on column public.vendors.platform_vendor_id is
  'The PLATFORM vendor identity this tenant bench row is a copy of '
  '(vendor_marketplace_profiles.id). Two bench rows under different brokerages '
  'sharing this value are the SAME REAL COMPANY — that is how a title company or '
  'lender is shared across brokerages (m549). NULL means the company has no '
  'platform account, which is a real state, not a missing one. This column is the '
  'only cross-tenant key on vendors; it grants no cross-tenant READ (RLS is '
  'unchanged) and exists so the platform can answer one question: is this vendor '
  'already paying for platform use somewhere else?';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. BACKFILL from the one join that already existed. Runs BEFORE the unique
--    indexes so a collision fails the migration loudly instead of silently
--    leaving half the rows unlinked.
-- ─────────────────────────────────────────────────────────────────────────────

update public.vendors v
set platform_vendor_id = p.id
from public.user_role_assignments ura
join public.vendor_marketplace_profiles p on p.user_id = ura.user_id
where ura.vendor_id = v.id
  and v.platform_vendor_id is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. THE MANY-TO-MANY IS WELL-DEFINED. One bench row per (platform vendor,
--    brokerage) — otherwise "which brokerages use this vendor" double-counts and
--    the no-double-charge query cannot be trusted. And at most one GLOBAL row per
--    platform vendor, since a global row belongs to no tenant.
-- ─────────────────────────────────────────────────────────────────────────────

create index if not exists idx_vendors_platform_vendor
  on public.vendors (platform_vendor_id)
  where platform_vendor_id is not null;

create unique index if not exists vendors_one_bench_row_per_tenant_per_platform_vendor
  on public.vendors (brokerage_id, platform_vendor_id)
  where platform_vendor_id is not null and brokerage_id is not null;

create unique index if not exists vendors_one_global_row_per_platform_vendor
  on public.vendors (platform_vendor_id)
  where platform_vendor_id is not null and brokerage_id is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. THE QUESTION, ASKABLE AT LAST. Returns WHO the vendor already pays for
--    platform use — 'platform', 'another_tenant', or NULL for nobody.
--
--    The vocabularies are the live ones, not retyped guesses:
--      vendor_marketplace_profiles.subscription_status … active | past_due |
--        canceled | trialing (lib/kernel/vendor-subscription.ts). Only active and
--        trialing are a LIVE arrangement — a lapsed one is not being charged, so
--        there is nothing to charge twice.
--      vendor_subscriptions.status … live CHECK (active | paused | canceled).
--        Only 'active' is running.
--
--    SECURITY DEFINER because it must see across tenants; it returns a LABEL, not
--    a tenant id, a plan or an amount, so nothing crosses the tenant line except
--    the answer.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.vendor_platform_use_already_paid(
  p_vendor_id uuid,
  p_brokerage_id uuid
) returns text
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $fn$
  with ident as (
    select v.platform_vendor_id as pid
    from public.vendors v
    where v.id = p_vendor_id
  )
  select case
    -- No platform identity ⇒ this company is on the platform nowhere else, so no
    -- existing arrangement can be double-charged.
    when (select pid from ident) is null then null

    -- (b), first form: the vendor pays the PLATFORM directly (VENDOR_PLATFORM_TIER).
    when exists (
      select 1
      from public.vendor_marketplace_profiles p
      where p.id = (select pid from ident)
        and coalesce(p.subscription_status, '') in ('active', 'trialing')
    ) then 'platform'

    -- (b), second form: the vendor pays ANOTHER BROKERAGE for a package
    -- (VENDOR_PACKAGE). Same real company, different tenant's bench row.
    when exists (
      select 1
      from public.vendors sib
      join public.vendor_subscriptions vs on vs.vendor_id = sib.id
      where sib.platform_vendor_id = (select pid from ident)
        and sib.id <> p_vendor_id
        and sib.brokerage_id is not null
        and sib.brokerage_id is distinct from p_brokerage_id
        and vs.status = 'active'
    ) then 'another_tenant'

    else null
  end;
$fn$;

comment on function public.vendor_platform_use_already_paid(uuid, uuid) is
  'Who this vendor ALREADY pays for platform use, seen from the brokerage that '
  'wants to charge: platform | another_tenant | NULL for nobody (m549). Returns a '
  'label, never a tenant identity — the answer crosses the tenant line, the data '
  'does not.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. THE RULE, ENFORCED. Both platform-use lanes:
--      vendor_subscriptions  — a package enrolment becoming ACTIVE
--      vendor_invoices       — a row billed_to='vendor', the one tenant→vendor ledger
--    vendor_invoices with billed_to 'brokerage' or 'contact' is untouched: that is
--    VENDOR_JOB_BILL, money for WORK PERFORMED flowing the other way. A vendor
--    already paying for platform use must still be paid for the jobs it does.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.enforce_vendor_platform_use_single_charge()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_is_platform_use boolean := false;
  v_payee text;
begin
  if tg_table_name = 'vendor_subscriptions' then
    v_is_platform_use := coalesce(new.status, 'active') = 'active';
    -- An UPDATE that leaves an ALREADY-active enrolment active is bookkeeping on a
    -- charge that was permitted when it was raised; only the transition INTO a
    -- live arrangement is judged. Otherwise ending someone else's enrolment could
    -- not be recorded on a row this rule now disallows.
    if tg_op = 'UPDATE' and coalesce(old.status, '') = 'active' then
      v_is_platform_use := false;
    end if;

  elsif tg_table_name = 'vendor_invoices' then
    v_is_platform_use := new.billed_to = 'vendor';
    if tg_op = 'UPDATE' and coalesce(old.billed_to, '') = 'vendor' then
      v_is_platform_use := false;
    end if;
  end if;

  if not v_is_platform_use then
    return new;
  end if;

  v_payee := public.vendor_platform_use_already_paid(new.vendor_id, new.brokerage_id);

  if v_payee = 'platform' then
    raise exception
      'This vendor already pays the platform for platform use, so it cannot be charged for platform use again. Grant contact access instead — that is free. (m549)'
      using errcode = '23514';
  elsif v_payee = 'another_tenant' then
    raise exception
      'This vendor is already on the platform through another brokerage and pays for platform use there, so it cannot be charged for platform use again. Grant contact access instead — that is free. (m549)'
      using errcode = '23514';
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_vendor_subscriptions_single_platform_use on public.vendor_subscriptions;
create trigger trg_vendor_subscriptions_single_platform_use
  before insert or update on public.vendor_subscriptions
  for each row execute function public.enforce_vendor_platform_use_single_charge();

drop trigger if exists trg_vendor_invoices_single_platform_use on public.vendor_invoices;
create trigger trg_vendor_invoices_single_platform_use
  before insert or update on public.vendor_invoices
  for each row execute function public.enforce_vendor_platform_use_single_charge();

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION (run after applying; the live two-sided controls are in
-- scripts/vendor-platform-use-double-charge-simulator.ts):
--
--   -- the link, its FK and its uniqueness rules exist
--   select column_name from information_schema.columns
--    where table_name='vendors' and column_name='platform_vendor_id';
--   select indexname from pg_indexes where tablename='vendors'
--    and indexname like 'vendors_one_%_platform_vendor%';
--
--   -- NEGATIVE CONTROL: a vendor with no platform identity is chargeable
--   select public.vendor_platform_use_already_paid(<vendor with NULL link>, <brokerage>);
--     -- expected NULL
--
--   -- POSITIVE CONTROL: link that vendor to a profile whose subscription_status
--   -- is 'active' and ask again
--     -- expected 'platform', and an INSERT of a billed_to='vendor' invoice for it
--     -- must be REFUSED by trg_vendor_invoices_single_platform_use.
-- ─────────────────────────────────────────────────────────────────────────────
