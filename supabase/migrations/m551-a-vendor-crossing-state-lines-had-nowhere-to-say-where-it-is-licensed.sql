-- m551 — A VENDOR CROSSING STATE LINES HAD NOWHERE TO SAY WHERE IT IS LICENSED
-- =============================================================================
--
-- OWNER QUESTION, verbatim:
--
--   "in your expert experience when setting up a vendor marketplace how do you
--    recommended setting up multiple tenancies and thier marektplace since some
--    vendors may cover multiple territories and how can you setup vendors to pay
--    when they can clearly cross territories or even states and still offer a
--    vendor system to the tenants to make a bit more money without over charging
--    the vendors??"
--
-- This migration is the FIRST BUILDABLE PIECE of the answer and only that. It
-- builds WHERE A COMPANY MAY WORK and WHETHER IT IS ALLOWED TO WORK THERE. It
-- prices nothing. m549's single-platform-use trigger is untouched and is not
-- weakened by anything here; the pricing shape this model implies is written
-- down in lib/vendors/vendor-service-area.ts :: VENDOR_COVERAGE_PRICING_IMPLICATIONS
-- for the owner to rule on, not implemented.
--
-- ── THE CAPABILITY WAS ABSENT, MEASURED ──────────────────────────────────────
--
-- Counted live before writing this (public schema, 2026-08-24):
--
--   · `vendors` has NO geographic column of any kind. Not state, not zip, not
--     city. A bench row cannot say where its company works.
--   · `vendor_marketplace_profiles` — the GLOBAL vendor identity from m549 — has
--     none either.
--   · The only territory-ish tables are `farm_territories` (an AGENT's farm),
--     `subscriber_service_areas` (a TENANT's own markets) and `territory_metrics`
--     (lead performance by ZIP). None of them is vendor coverage, and none of
--     them has a vendor_id.
--
-- So there is no duplicate to merge onto (CLAUDE.md §1.1 does not apply) and the
-- capability is wanted. §1.2: BUILD the missing half.
--
-- ── WHY THIS HANGS OFF THE GLOBAL PROFILE, NOT OFF `vendors` ─────────────────
--
-- m549 established the split: `vendor_marketplace_profiles` is the COMPANY
-- (UNIQUE on company_name, no brokerage_id, carries the subscription and stripe
-- facts), `vendors` is a TENANT'S BENCH ROW for that company, linked by
-- vendors.platform_vendor_id.
--
-- Coverage is a fact about the COMPANY. A title company's Arizona licence does
-- not change because a second brokerage added them. Hanging coverage off
-- `vendors` would mint one coverage answer per tenant for one real company —
-- precisely the many-truths shape m549 was written to end — and would force a
-- vendor crossing territories to re-declare and re-prove the same licence once
-- per brokerage that hired them.
--
-- ── THE GRAIN IS state + zip_code, AND IT WAS COUNTED, NOT CHOSEN ────────────
--
-- CLAUDE.md §6 forbids a third geographic vocabulary. Live column counts:
--
--   state       30 tables      city  23 tables
--   zip_code    15 tables      zip    8 tables
--   county       0 tables      metro / metro_area / msa   0 tables
--
-- The repo's finer grain IS the ZIP and its majority spelling is `zip_code`.
-- County and metro do not exist here — choosing either would mean inventing a
-- vocabulary and then keeping it in sync with the ZIP data every other table
-- already stores. The decisive precedent is `subscriber_service_areas`, the
-- TENANT side of this same question, already live as (brokerage_id, team_id,
-- agent_user_id, zip_code, city, state, is_primary, active). This table is its
-- vendor-side counterpart and is spelled to match, so "does the vendor cover
-- where this tenant works" is one comparison in one vocabulary.
--
-- ── THE LICENCE SHAPE IS NOT A NEW ONE ───────────────────────────────────────
--
-- `vendors.compliance_credentials` is already a credential bag validated live by
-- vendor_credential_bag_ok / vendor_credential_record_ok (keys: license,
-- insurance, certification, bond). The per-state licence below reuses
-- `vendor_credential_record_ok` VERBATIM, so this repo has ONE credential record
-- shape and not two (§6). What is new is only that a licence can now be attached
-- to a STATE, which the single bag on a tenant bench row could never say.
--
-- ── FAIL CLOSED ──────────────────────────────────────────────────────────────
--
-- CLAUDE.md §4. `vendor_bookable_in_state` returns a REASON CODE, never a bare
-- boolean, and 'covered' is the only value that means yes. Unknown coverage
-- returns 'vendor_coverage_unknown' and the booking trigger refuses it. Nothing
-- here can render "nobody declared coverage" as "checked and fine".
--
-- APPLICATION STATUS: APPLIED 2026-08-24 to project hrvaqgvukzxfskkcrwbt.
--   Two-sided live controls were run against the applied schema and their
--   fixtures removed; results are in the lane report. No assertion anywhere is
--   pinned to the words of this line (CLAUDE.md §2 — do not pin an assertion to
--   a waypoint): scripts/vendor-service-area-simulator.ts asks the DATABASE
--   whether the table, the functions and the trigger are there, and reports the
--   pre-migration shape honestly where they are not.
--
--   BLAST RADIUS, measured before applying: vendors=1 (global, platform_vendor_id
--   NULL), vendor_marketplace_profiles=0, subscriber_service_areas=0,
--   vendor_bookings=0. So the fail-closed booking gate refuses nothing that
--   exists today — there is no live bench it can take dark.
--
--   SCHEMA CACHES (CLAUDE.md §3): this adds a TABLE with CHECK constraints, so
--   the generated caches drifted the moment it was applied. They have SINCE BEEN
--   REGENERATED — by another lane's `npm run schema:regen` on 2026-08-24, not by
--   hand — and they now carry it. VERIFIED, not assumed:
--     scripts/live-tables.ts:768        "vendor_service_areas"  (764 → 765 relations)
--     scripts/schema-fk-map.ts:785      vendor_service_areas.platform_vendor_id
--                                       -> vendor_marketplace_profiles
--     scripts/check-vocabularies.ts:1597 status  = active|suspended|withdrawn
--                                        trade_category = the 38-value taxonomy
--   That last entry is an INDEPENDENT confirmation that the 38 values written
--   out in the CHECK below are the same 38 the live vendors_category_check holds:
--   the cache was generated FROM the database, not from this file.
--   All four caches are MACHINE-WRITTEN with a body-sha256 stamp and were
--   deliberately NOT hand-edited by this lane. `npm run test:schema-cache-drift`
--   and `npm run test:check-vocabulary` both pass against them.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE COVERAGE TABLE.
--
--    zip_code NULL means STATEWIDE and is a real, common declaration — a title
--    company licensed in a state works the whole state. It is not a missing
--    value, so the column is nullable ON PURPOSE and the uniqueness rule below
--    accounts for it rather than pretending NULL rows are all distinct.
--
--    trade_category is on the COVERAGE ROW, not on the profile, for two reasons.
--    (a) `vendor_marketplace_profiles.category` is a live CHECK over
--        ('api','service','tool','integration') — a marketplace-INTEGRATION
--        vocabulary, not a trade. It cannot say "title company".
--    (b) Licensure is genuinely per (trade, state): a company doing both title
--        and lending holds two different licences in the same state. One trade
--        per row is what lets the licence hang where it actually belongs.
--    The vocabulary is the 38-value `vendors.category` taxonomy VERBATIM (the
--    same list vendor_directory.category has used since m304), so no second
--    spelling of a vendor trade is created (§6).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.vendor_service_areas (
  id uuid primary key default gen_random_uuid(),

  platform_vendor_id uuid not null
    references public.vendor_marketplace_profiles(id) on delete cascade,

  state text not null,
  zip_code text,
  trade_category text not null,

  license jsonb,

  status text not null default 'active',

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- State is stored normalised so a comparison never has to guess. 'az' and 'AZ'
-- must not be two coverage areas.
alter table public.vendor_service_areas
  drop constraint if exists vendor_service_areas_state_check;
alter table public.vendor_service_areas
  add constraint vendor_service_areas_state_check
  check (state ~ '^[A-Z]{2}$');

-- The 5-digit grain every other table in this repo stores. ZIP+4 is normalised
-- away by the writer, not admitted here.
alter table public.vendor_service_areas
  drop constraint if exists vendor_service_areas_zip_code_check;
alter table public.vendor_service_areas
  add constraint vendor_service_areas_zip_code_check
  check (zip_code is null or zip_code ~ '^[0-9]{5}$');

-- The trade vocabulary, verbatim from the live vendors_category_check. Written
-- out rather than derived because a CHECK cannot reference another table, and
-- the guard asserts the two lists are IDENTICAL so they cannot drift apart.
alter table public.vendor_service_areas
  drop constraint if exists vendor_service_areas_trade_category_check;
alter table public.vendor_service_areas
  add constraint vendor_service_areas_trade_category_check
  check (trade_category = any (array[
    'inspector','lender','title','attorney','contractor','stager','photographer',
    'cleaner','mover','insurance','handyman','property_management','landscaping',
    'pest_control','pool_service','hvac','plumber','electrician','roofer','painter',
    'flooring','solar','security','smart_home','appliance_repair','window_treatment',
    'garage_door','refinance_lender','home_warranty','tax_pro','financial_advisor',
    'interior_design','organizer','estate_sale','videographer','drone_pilot',
    '3d_tour','other'
  ]));

-- 'withdrawn' is the vendor leaving a market; 'suspended' is the platform holding
-- them out of it. Both stop the work — keeping them apart is the difference
-- between a business decision and an enforcement action, and a support agent
-- needs to know which one they are looking at.
alter table public.vendor_service_areas
  drop constraint if exists vendor_service_areas_status_check;
alter table public.vendor_service_areas
  add constraint vendor_service_areas_status_check
  check (status = any (array['active','suspended','withdrawn']));

-- ONE credential shape in this repo, not two (§6): the same validator that
-- already guards vendors.compliance_credentials records.
alter table public.vendor_service_areas
  drop constraint if exists vendor_service_areas_license_shape;
alter table public.vendor_service_areas
  add constraint vendor_service_areas_license_shape
  check (license is null or public.vendor_credential_record_ok(license));

comment on table public.vendor_service_areas is
  'WHERE A VENDOR COMPANY MAY WORK, and on what licence (m551). Hangs off the '
  'GLOBAL identity vendor_marketplace_profiles, never off a tenant bench row: '
  'coverage is a fact about the company, so a title company licensed in AZ is '
  'licensed in AZ for every brokerage that benches it. Grain is state + zip_code '
  '— the vocabulary subscriber_service_areas (the tenant side of this same '
  'question) already uses. zip_code NULL means STATEWIDE and is a real '
  'declaration, not a missing value.';

comment on column public.vendor_service_areas.license is
  'The state licence backing this coverage, in the SAME record shape as '
  'vendors.compliance_credentials -> ''license'' (validated by the same '
  'vendor_credential_record_ok). Required in practice for state-licensed trades '
  '— title, lender, refinance_lender, attorney, insurance — where '
  'vendor_bookable_in_state refuses coverage without a current one. NULL is '
  'legitimate for a trade that needs no state licence.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. UNIQUENESS. One declaration per (company, trade, place). Two partial
--    uniques rather than one over COALESCE(zip_code,'') because a statewide row
--    and a ZIP row are different declarations that may coexist — a lender may
--    cover all of AZ and hold a separate note on one ZIP — while two identical
--    statewide rows are a duplicate that would double-count reach, which is the
--    number every future pricing shape would be computed from.
-- ─────────────────────────────────────────────────────────────────────────────

create unique index if not exists vendor_service_areas_one_statewide_per_trade
  on public.vendor_service_areas (platform_vendor_id, trade_category, state)
  where zip_code is null;

create unique index if not exists vendor_service_areas_one_zip_per_trade
  on public.vendor_service_areas (platform_vendor_id, trade_category, state, zip_code)
  where zip_code is not null;

create index if not exists idx_vendor_service_areas_lookup
  on public.vendor_service_areas (state, trade_category)
  where status = 'active';

create index if not exists idx_vendor_service_areas_vendor
  on public.vendor_service_areas (platform_vendor_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RLS. The table is GLOBAL — it has no brokerage_id and must not grow one,
--    because coverage is not a tenant fact. So the read is deliberately open to
--    authenticated users: a tenant has to be able to see that a vendor covers
--    their market in order to bench them, and a coverage row carries no
--    financials, no contacts and no tenant identity — nothing CLAUDE.md §5 keeps
--    behind the tenant line. WRITES are the vendor's own or platform staff's.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.vendor_service_areas enable row level security;

drop policy if exists vendor_service_areas_authenticated_browse on public.vendor_service_areas;
create policy vendor_service_areas_authenticated_browse
  on public.vendor_service_areas for select to authenticated
  using (true);

drop policy if exists vendor_service_areas_vendor_manage_own on public.vendor_service_areas;
create policy vendor_service_areas_vendor_manage_own
  on public.vendor_service_areas for all to authenticated
  using (public.is_current_user_marketplace_vendor(platform_vendor_id))
  with check (public.is_current_user_marketplace_vendor(platform_vendor_id));

drop policy if exists vendor_service_areas_platform_manage on public.vendor_service_areas;
create policy vendor_service_areas_platform_manage
  on public.vendor_service_areas for all to authenticated
  using (public.is_platform_staff())
  with check (public.is_platform_staff());

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. WHICH TRADES ARE STATE-LICENSED.
--
--    Named once, here and in lib/vendors/vendor-service-area.ts ::
--    STATE_LICENSED_VENDOR_CATEGORIES, and the guard asserts the two lists are
--    identical — a licensed trade that only one side knows about is a gate that
--    is enforced in one place and open in the other.
--
--    lender / refinance_lender  a mortgage originator holds state authority per
--                               state they lend in. The commonest cross-state
--                               vendor, and the owner named it.
--    title                      title/escrow producers are licensed state by
--                               state. The owner named it.
--    attorney                   admission is per state bar; an out-of-state
--                               attorney on a closing is unauthorised practice.
--    insurance                  producers hold per-state appointments.
--
--    `inspector` is deliberately ABSENT: home-inspector licensure is not
--    universal across states, so a hard refusal would refuse legitimate
--    inspectors everywhere that does not license them. A gate that is wrong in
--    one direction is not safer than no gate — it is a gate that gets switched
--    off.
--
--    APPRAISER IS MISSING FROM THE VOCABULARY ITSELF and that is a finding, not
--    an omission here. The owner named appraisers as state-licensed and
--    CLAUDE.md §5 treats them as first-class, but `vendors.category` has no
--    'appraiser' value — appraisers are reached through
--    lib/kernel/appraiser-packet.ts, not the vendor bench. Adding one means
--    widening a live CHECK and regenerating the vocabulary cache, which is not
--    this lane's to do. This function is the ONE place that would change.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.vendor_trade_requires_state_license(p_trade text)
returns boolean
language sql
immutable
parallel safe
set search_path to 'public', 'pg_temp'
as $fn$
  select coalesce(p_trade, '') = any (array[
    'lender', 'refinance_lender', 'title', 'attorney', 'insurance'
  ]);
$fn$;

comment on function public.vendor_trade_requires_state_license(text) is
  'Trades whose practitioners are STATE-LICENSED, so coverage in a state is only '
  'real when a current licence backs it (m551). Mirrored EXACTLY by '
  'lib/vendors/vendor-service-area.ts :: STATE_LICENSED_VENDOR_CATEGORIES; the '
  'guard asserts the two lists are identical.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. THE GATE. Returns a REASON CODE, never a bare boolean — 'covered' is the
--    only value that means yes, so a caller cannot accidentally read "we could
--    not tell" as "fine". The codes are the same ones
--    lib/vendors/vendor-service-area.ts returns.
--
--    SECURITY DEFINER because it must read a GLOBAL coverage table and a bench
--    row that belongs to one tenant; it returns a reason code and nothing else,
--    so no tenant data crosses the line.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.vendor_bookable_in_state(
  p_vendor_id uuid,
  p_state text,
  p_zip text default null
) returns text
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_pid   uuid;
  v_trade text;
  v_bench_license jsonb;
  v_state text := upper(nullif(trim(coalesce(p_state, '')), ''));
  v_zip   text := substring(nullif(trim(coalesce(p_zip, '')), '') from '^[0-9]{5}');
  v_needs_license boolean;
  v_any_admitting boolean;
  v_any_active boolean;
  v_any_licensed boolean;
  v_any_license_on_file boolean;
begin
  if v_state !~ '^[A-Z]{2}$' then
    return 'job_state_unknown';
  end if;

  select v.platform_vendor_id, v.category, v.compliance_credentials -> 'license'
    into v_pid, v_trade, v_bench_license
  from public.vendors v
  where v.id = p_vendor_id;

  if not found then
    -- A vendor that does not exist is not bookable. Distinct from a coverage
    -- answer so a bad id cannot read as a coverage refusal.
    return 'vendor_not_found';
  end if;

  v_needs_license := public.vendor_trade_requires_state_license(v_trade);

  -- A LOCAL bench row (no platform identity) is a company this tenant added by
  -- hand for its own market. No cross-territory claim is being made, so there is
  -- no coverage to intersect. The LICENCE question still applies, answered from
  -- the bench row's own credential bag — which carries no state, so the best it
  -- can say is "on file". Saying that, rather than 'covered', is the point.
  if v_pid is null then
    if not v_needs_license then
      return 'local_bench_row';
    end if;
    if v_bench_license is null or jsonb_typeof(v_bench_license) <> 'object' then
      return 'licence_missing';
    end if;
    if (v_bench_license ->> 'expiry') is not null
       and (v_bench_license ->> 'expiry')::date <= current_date then
      return 'licence_expired';
    end if;
    return 'local_bench_row';
  end if;

  select
    count(*) > 0,
    count(*) filter (where sa.status = 'active') > 0,
    count(*) filter (
      where sa.status = 'active'
        and sa.license is not null
        and ( (sa.license ->> 'expiry') is null
              or (sa.license ->> 'expiry')::date > current_date )
    ) > 0,
    count(*) filter (where sa.status = 'active' and sa.license is not null) > 0
  into v_any_admitting, v_any_active, v_any_licensed, v_any_license_on_file
  from public.vendor_service_areas sa
  where sa.platform_vendor_id = v_pid
    and sa.trade_category = v_trade
    and sa.state = v_state
    -- A statewide row admits any ZIP in its state. A ZIP-scoped row admits only
    -- that ZIP, and CANNOT admit a job whose ZIP is unknown — "probably in
    -- range" is exactly the fail-open this gate exists to prevent.
    and (sa.zip_code is null or (v_zip is not null and sa.zip_code = v_zip));

  if not v_any_admitting then
    -- Distinguish "declared nothing anywhere" from "declared, but not here":
    -- they have different fixes and an operator needs to be told which.
    if not exists (
      select 1 from public.vendor_service_areas sa2 where sa2.platform_vendor_id = v_pid
    ) then
      return 'vendor_coverage_unknown';
    end if;
    return 'no_overlap';
  end if;

  if not v_any_active then
    return 'coverage_not_active';
  end if;

  if not v_needs_license then
    return 'covered';
  end if;

  if v_any_licensed then
    return 'covered';
  end if;

  return case when v_any_license_on_file then 'licence_expired' else 'licence_missing' end;
end;
$fn$;

comment on function public.vendor_bookable_in_state(uuid, text, text) is
  'May this vendor be booked for a job at this place? Returns a REASON CODE — '
  '''covered'' and ''local_bench_row'' mean yes, everything else is a refusal '
  'naming its cause (m551). Never a bare boolean, so "we could not tell" can '
  'never be read as "fine". Mirrors lib/vendors/vendor-service-area.ts :: '
  'vendorGeoVerdict.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. THE GATE, ENFORCED ON THE BOOKING ITSELF.
--
--    A rule that lives only in the application is one a future writer re-opens
--    by adding a second booking lane — m497 records exactly that happening to
--    the vendor money DIRECTION, and m549 put its rule in the database for the
--    same reason. This makes an unlicensed cross-state booking UNREPRESENTABLE.
--
--    WHERE THE JOB'S STATE COMES FROM. `vendor_bookings` carries no geography of
--    its own; it carries listing_id, transaction_id and contact_id. The state is
--    resolved down that chain, most specific first — the listing is the
--    property, the transaction points at a listing, and the contact's own
--    address is the last resort.
--
--    WHEN THE STATE CANNOT BE RESOLVED AT ALL, the booking is ALLOWED and the
--    row is left alone. That is a deliberate, narrow opening and it is stated
--    here rather than hidden: `vendor_bookings.listing_id`, `transaction_id` and
--    `contact_id` are ALL nullable, so a booking with no geography is a shape the
--    schema permits today, and refusing it would break the existing
--    contact-request lane for every vendor whose trade needs no licence at all.
--    The licence gate still bites the moment any of those is present. Closing
--    this needs geography made mandatory on the booking, which is a product
--    change and not this lane's to make.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.enforce_vendor_booking_service_area()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_state text;
  v_zip   text;
  v_verdict text;
begin
  -- Most specific first: the listing IS the property.
  if new.listing_id is not null then
    select l.state, l.zip into v_state, v_zip
    from public.listings l where l.id = new.listing_id;
  end if;

  if v_state is null and new.transaction_id is not null then
    select l.state, l.zip into v_state, v_zip
    from public.transactions t
    join public.listings l on l.id = t.listing_id
    where t.id = new.transaction_id;
  end if;

  if v_state is null and new.contact_id is not null then
    select c.state, c.zip_code into v_state, v_zip
    from public.contacts c where c.id = new.contact_id;
  end if;

  -- No geography on the booking at all: see the note above. Nothing to judge.
  if v_state is null or trim(v_state) = '' then
    return new;
  end if;

  v_verdict := public.vendor_bookable_in_state(new.vendor_id, v_state, v_zip);

  if v_verdict in ('covered', 'local_bench_row', 'job_state_unknown') then
    return new;
  end if;

  if v_verdict in ('licence_missing', 'licence_expired') then
    raise exception
      'This trade is state-licensed and this vendor has no current licence on file for %. It cannot be booked there. (m551: %)',
      upper(v_state), v_verdict
      using errcode = '23514';
  end if;

  raise exception
    'This vendor does not cover %. (m551: %) Declare a service area for the vendor, or book one that already covers it.',
    upper(v_state), v_verdict
    using errcode = '23514';
end;
$fn$;

drop trigger if exists trg_vendor_bookings_service_area on public.vendor_bookings;
create trigger trg_vendor_bookings_service_area
  before insert or update of vendor_id, listing_id, transaction_id, contact_id
  on public.vendor_bookings
  for each row execute function public.enforce_vendor_booking_service_area();

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION (the live two-sided controls live in
-- scripts/vendor-service-area-simulator.ts and run in `npm run guard`):
--
--   -- the table, its uniqueness rules and the gate exist
--   select 1 from information_schema.tables where table_name='vendor_service_areas';
--   select indexname from pg_indexes where tablename='vendor_service_areas';
--
--   -- NEGATIVE CONTROL: a vendor that declared nothing is NOT bookable anywhere,
--   -- and is refused with the reason that names the fix
--   select public.vendor_bookable_in_state(<linked vendor, no coverage>, 'AZ');
--     -- expected 'vendor_coverage_unknown'  (NOT 'covered', NOT null)
--
--   -- POSITIVE CONTROL: declare active statewide coverage with a current licence
--   -- and ask again
--     -- expected 'covered'
--
--   -- COMPLIANCE CONTROL: expire that licence
--     -- expected 'licence_expired', and an INSERT into vendor_bookings for a
--     -- listing in that state must be REFUSED by trg_vendor_bookings_service_area.
-- ─────────────────────────────────────────────────────────────────────────────
