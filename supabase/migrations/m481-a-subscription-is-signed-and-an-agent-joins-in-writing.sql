-- m481 — A SUBSCRIPTION IS SIGNED, AND AN AGENT JOINS IN WRITING
-- ─────────────────────────────────────────────────────────────────────────────
-- OWNER RULING (verbatim): "platform contracts for tenants has to be written in
-- order for the tenant to sign for their subscription, also the agent has to
-- sign contracts to join the brokerage and teams so tenants need to write the
-- agency contracts for the agents to sign."
--
-- TWO LANES, ONE VOCABULARY:
--
--   LANE 1 — PLATFORM → TENANT. Platform staff AUTHOR subscription-agreement
--   templates (platform_contract_templates); a tenant's admin SIGNS one to put
--   their subscription in writing (tenant_contract_signatures). These are NEW
--   tables because nothing at platform grain existed: contract_signatures is
--   agent-keyed (agent_id NOT NULL → agents) and brokerage_forms is
--   tenant-authored — neither can hold a platform-authored template or a
--   brokerage-level signature without corrupting its grain.
--
--   LANE 2 — TENANT → AGENT. The signed record REUSES contract_signatures —
--   already the agent-contract ledger (contract_type, esign_status,
--   provider_name, fully_signed_at). MEASURED LIVE (2026-08-18, project
--   hrvaqgvukzxfskkcrwbt): contract_signatures_contract_type_check ALREADY
--   admits BOTH 'independent_contractor' AND 'team_agreement' (full list:
--   independent_contractor, team_agreement, policy_acknowledgment,
--   nar_code_of_ethics, commission_agreement, purchase_agreement, contract,
--   addendum, amendment, listing_agreement, buyer_representation_agreement,
--   disclosure, escrow_instructions, counter_offer, acceptance) — so the CHECK
--   is NOT rebuilt here; a guard below extends it only in an environment where
--   'team_agreement' is genuinely absent. What IS missing live is the TEAM pin:
--   a team-join contract row had no column saying WHICH team was joined, so
--   team_id (nullable — brokerage-join contracts have no team) is added.
--
-- DO NOT APPLY BY HAND — the session driver applies migrations.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. LANE 1 — the platform-authored subscription-agreement template.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.platform_contract_templates (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  -- One admitted type today. A CHECK, not an enum, so the family can widen the
  -- way contract_signatures' did (by extending the list, never by free text).
  contract_type      text not null default 'subscription_agreement'
    constraint platform_contract_templates_contract_type_check
      check (contract_type in ('subscription_agreement')),
  -- The contract itself: inline text OR a storage path — at least one, never
  -- neither (a template with no body is not a contract anyone can sign).
  body_text          text,
  body_storage_path  text,
  version            integer not null default 1,
  is_active          boolean not null default true,
  created_by         uuid references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint platform_contract_templates_body_present
    check (body_text is not null or body_storage_path is not null)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. LANE 1 — the tenant's signature on it. Brokerage-grain (this is the
--    TENANT signing, not an agent), immutable by policy (no UPDATE/DELETE
--    lane at all — a signed contract is a record, not a draft).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.tenant_contract_signatures (
  id                uuid primary key default gen_random_uuid(),
  brokerage_id      uuid not null references public.brokerages(id) on delete cascade,
  template_id       uuid not null references public.platform_contract_templates(id) on delete restrict,
  -- Snapshot of the template version that was on screen when signed — the
  -- template may be revised later; the signature stays pinned to what was read.
  template_version  integer,
  signed_by         uuid not null references public.users(id) on delete restrict,
  signed_name       text not null,
  -- The signature payload the in-app rail records (method, typed name, context)
  -- — mirroring how the transaction signature panel records a signing event as
  -- structured fact rather than pretending a provider envelope exists.
  signature         jsonb not null default '{}'::jsonb,
  signed_at         timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  -- One signature per brokerage per template — re-signing the same template is
  -- a no-op, a NEW template version that matters gets a NEW template row.
  constraint tenant_contract_signatures_once unique (brokerage_id, template_id)
);

create index if not exists idx_tenant_contract_signatures_brokerage
  on public.tenant_contract_signatures (brokerage_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. LANE 2 — the team pin on the agent-contract ledger. Nullable: an
--    independent-contractor (brokerage-join) contract has no team; a
--    team_agreement row records WHICH team was joined.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.contract_signatures
  add column if not exists team_id uuid references public.teams(id) on delete set null;

create index if not exists idx_contract_signatures_team
  on public.contract_signatures (team_id) where team_id is not null;

-- Guard: the live CHECK already admits 'team_agreement' (measured above), so
-- this fires only in an environment whose CHECK predates that list — there it
-- rebuilds the constraint with 'team_agreement' added, instead of silently
-- shipping code the database refuses.
do $$
declare v_def text;
begin
  select pg_get_constraintdef(oid) into v_def
  from pg_constraint
  where conrelid = 'public.contract_signatures'::regclass
    and conname = 'contract_signatures_contract_type_check';

  if v_def is not null and v_def !~ 'team_agreement' then
    execute 'alter table public.contract_signatures drop constraint contract_signatures_contract_type_check';
    execute replace(
      'alter table public.contract_signatures add constraint contract_signatures_contract_type_check ' ||
      substring(v_def from 'CHECK.*$'),
      '''independent_contractor''::text',
      '''independent_contractor''::text, ''team_agreement''::text'
    );
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS. Platform templates: readable by any signed-in tenant seat while
--    ACTIVE (a tenant must be able to READ the contract they are asked to
--    sign; platform staff read all, including retired versions); written by
--    platform staff ONLY (public.is_platform_staff() — the repo's existing
--    platform predicate). Tenant signatures: written by the tenant's admin
--    seats (public.is_brokerage_admin(), tenant-pinned), read by the same
--    tenant + platform staff.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.platform_contract_templates enable row level security;
alter table public.tenant_contract_signatures  enable row level security;

drop policy if exists platform_contract_templates_read on public.platform_contract_templates;
create policy platform_contract_templates_read
  on public.platform_contract_templates for select
  to authenticated
  using (is_active or public.is_platform_staff());

drop policy if exists platform_contract_templates_insert on public.platform_contract_templates;
create policy platform_contract_templates_insert
  on public.platform_contract_templates for insert
  to authenticated
  with check (public.is_platform_staff());

drop policy if exists platform_contract_templates_update on public.platform_contract_templates;
create policy platform_contract_templates_update
  on public.platform_contract_templates for update
  to authenticated
  using (public.is_platform_staff())
  with check (public.is_platform_staff());

drop policy if exists platform_contract_templates_delete on public.platform_contract_templates;
create policy platform_contract_templates_delete
  on public.platform_contract_templates for delete
  to authenticated
  using (public.is_platform_staff());

drop policy if exists tenant_contract_signatures_read on public.tenant_contract_signatures;
create policy tenant_contract_signatures_read
  on public.tenant_contract_signatures for select
  to authenticated
  using (brokerage_id = public.current_user_brokerage_id() or public.is_platform_staff());

-- INSERT only. No UPDATE and no DELETE policy on purpose: under RLS the absent
-- lane is a refusal, which is exactly what "a signature is immutable" means.
drop policy if exists tenant_contract_signatures_insert on public.tenant_contract_signatures;
create policy tenant_contract_signatures_insert
  on public.tenant_contract_signatures for insert
  to authenticated
  with check (
    public.is_brokerage_admin()
    and brokerage_id = public.current_user_brokerage_id()
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Postconditions — raise, never trust.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare v_bad int; v_def text;
begin
  -- Both lane-1 tables exist with RLS ON.
  select count(*) into v_bad from pg_tables
  where schemaname = 'public'
    and tablename in ('platform_contract_templates', 'tenant_contract_signatures')
    and rowsecurity;
  if v_bad <> 2 then
    raise exception 'm481: expected 2 lane-1 tables with RLS enabled, found %', v_bad;
  end if;

  -- Every WRITE policy on the platform template table is pinned to the
  -- platform predicate — no tenant seat can author a platform contract.
  select count(*) into v_bad from pg_policies
  where schemaname = 'public' and tablename = 'platform_contract_templates'
    and cmd <> 'SELECT'
    and coalesce(qual, with_check) !~ 'is_platform_staff';
  if v_bad <> 0 then
    raise exception 'm481: % platform_contract_templates write policies are not platform-pinned', v_bad;
  end if;

  -- The tenant-signature INSERT lane carries BOTH the admin predicate and the
  -- tenant pin, and there is no UPDATE/DELETE lane at all (immutability).
  select count(*) into v_bad from pg_policies
  where schemaname = 'public' and tablename = 'tenant_contract_signatures'
    and cmd = 'INSERT'
    and with_check ~ 'is_brokerage_admin' and with_check ~ 'current_user_brokerage_id';
  if v_bad <> 1 then
    raise exception 'm481: tenant_contract_signatures INSERT policy lost its admin+tenant pin';
  end if;
  select count(*) into v_bad from pg_policies
  where schemaname = 'public' and tablename = 'tenant_contract_signatures'
    and cmd in ('UPDATE', 'DELETE');
  if v_bad <> 0 then
    raise exception 'm481: a signature became editable — % UPDATE/DELETE policies on tenant_contract_signatures', v_bad;
  end if;

  -- Lane 2: the ledger admits 'team_agreement' and carries the team pin.
  select pg_get_constraintdef(oid) into v_def
  from pg_constraint
  where conrelid = 'public.contract_signatures'::regclass
    and conname = 'contract_signatures_contract_type_check';
  if v_def is null or v_def !~ 'team_agreement' or v_def !~ 'independent_contractor' then
    raise exception 'm481: contract_signatures contract_type CHECK does not admit both agency contract types';
  end if;

  select count(*) into v_bad from information_schema.columns
  where table_schema = 'public' and table_name = 'contract_signatures' and column_name = 'team_id';
  if v_bad <> 1 then
    raise exception 'm481: contract_signatures.team_id was not added';
  end if;
end $$;
