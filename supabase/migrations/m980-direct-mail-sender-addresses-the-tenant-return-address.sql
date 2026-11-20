-- ── APPLIED LIVE 2026-11-09 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 151, lane 151H ──
--
-- m980 — THE TENANT'S SENDER (RETURN) ADDRESS FOR DIRECT MAIL (owner, verbatim: "direct mail, the rendered pieces should not
-- use the platform return address"; directive 151H: "Use the tenant's configured return mailing address, or another address
-- expressly approved for the actual sender. Check postal deliverability and source ownership.")
--
-- WHAT THE CODE NOW READS AND WRITES:
--   · public.direct_mail_sender_addresses — a tenant's configured return addresses: one default per scope (the tenant, a team,
--     a sending user), each CASS-verified once (Lob US verification; the verdict and its time are stored) and APPROVED by a
--     tenant admin (approved_by_user_id / approved_at — the evidence that this address may stand as the sender).
--     WRITER: app/actions/direct-mail-settings.ts (saveSenderAddress / approveSenderAddress / setDefaultSenderAddress /
--     retireSenderAddress — session-gated, tenant from the policy scope).
--     READERS: lib/direct-mail/piece-type.ts resolveTenantSenderAddress (the ONE resolver the dispatcher
--     lib/providers/dispatch.ts, every mail door and Settings ask) → lib/providers/mailing-cass-gate.ts decideSenderAddress.
--   · public.direct_mail_campaigns.sender_address_id / sender_address_snapshot — what the campaign's pieces carried as the
--     sender (evidence beside the piece: LAW 5). WRITER: app/actions/direct-mail.ts sendCampaign (a SEPARATE write, so a
--     pending migration cannot take the send's status write down). READER: the campaigns tab (getMailCampaigns selects *).
--
-- WHAT IS DELIBERATELY NOT HERE: no platform address anywhere. The platform's saved Lob address (env NAME LOB_RETURN_ADDRESS_ID)
-- is read by the gate only to RECOGNIZE and REFUSE it. No scope row defaults to it; no fallback reaches it.
--
-- Live rows before (2026-11-09): direct_mail_campaigns has no sender columns; no table of sender addresses exists. Nothing to
-- backfill: a tenant with no approved row resolves to its own brokerage-of-record business address (brokerages.address …),
-- CASS-verified at resolve time when LOB_API_KEY is present, else REFUSED by name (never substituted).
--
-- After apply: regenerate scripts/schema-snapshot.ts, scripts/schema-fk-map.ts, scripts/live-tables.ts and
-- scripts/check-vocabularies.ts (two new CHECKs below) from the live catalog.

begin;

create table if not exists public.direct_mail_sender_addresses (
  id                  uuid primary key default gen_random_uuid(),
  brokerage_id        uuid not null references public.brokerages(id) on delete cascade,
  -- Whose address this is: the tenant itself, one of its teams, or one sending user (users.id — never agents.id).
  scope_type          text not null,
  scope_id            uuid not null,
  label               text,
  -- The sender's legal / business identity printed as the return name — the tenant's, never the platform's.
  name                text not null,
  line1               text not null,
  line2               text,
  city                text not null,
  state               text not null,
  zip                 text not null,
  -- CASS evidence (Lob US verification): the bucket and when. null = never verified → the gate refuses the address as a sender.
  cass_deliverability text,
  cass_verified_at    timestamptz,
  cass_source         text,
  -- Approval evidence: a tenant admin expressly approved this address for the scope.
  approved_by_user_id uuid references public.users(id) on delete set null,
  approved_at         timestamptz,
  is_default          boolean not null default false,
  status              text not null default 'active',
  created_by_user_id  uuid references public.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'direct_mail_sender_addresses_scope_type_check') then
    alter table public.direct_mail_sender_addresses add constraint direct_mail_sender_addresses_scope_type_check
      check (scope_type in ('brokerage', 'team', 'user'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'direct_mail_sender_addresses_status_check') then
    alter table public.direct_mail_sender_addresses add constraint direct_mail_sender_addresses_status_check
      check (status in ('active', 'retired'));
  end if;
end $$;

-- One DEFAULT per (tenant, scope) among active rows; a scope may hold several approved addresses.
create unique index if not exists direct_mail_sender_addresses_default_uq
  on public.direct_mail_sender_addresses (brokerage_id, scope_type, scope_id)
  where is_default and status = 'active';
create index if not exists direct_mail_sender_addresses_tenant_idx
  on public.direct_mail_sender_addresses (brokerage_id, status);

comment on table public.direct_mail_sender_addresses is
  'The tenant''s configured return (sender) addresses for direct mail, per scope (brokerage / team / user), CASS-verified once and approved by a tenant admin. The platform''s address is never a row here and never a fallback (wave 151, lane 151H).';
comment on column public.direct_mail_sender_addresses.cass_verified_at is
  'When Lob US verification ruled on this address (lib/providers/mailing-cass-gate.ts decideSenderAddress refuses a sender with no verification).';

-- RLS: tenant members read their own tenant's rows; writes go through the service client behind the session-gated
-- Settings action (app/actions/direct-mail-settings.ts), the same posture as the farm-mail config on brokerages.
alter table public.direct_mail_sender_addresses enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'direct_mail_sender_addresses' and policyname = 'direct_mail_sender_addresses_tenant_select') then
    create policy direct_mail_sender_addresses_tenant_select on public.direct_mail_sender_addresses
      for select using (brokerage_id = public.current_user_brokerage_id());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'direct_mail_sender_addresses' and policyname = 'direct_mail_sender_addresses_platform_staff_all') then
    create policy direct_mail_sender_addresses_platform_staff_all on public.direct_mail_sender_addresses
      for all using (public.is_platform_staff()) with check (public.is_platform_staff());
  end if;
end $$;

-- ── direct_mail_campaigns: what the pieces carried as the sender (evidence) ──────────────────────────
alter table public.direct_mail_campaigns
  add column if not exists sender_address_id       uuid references public.direct_mail_sender_addresses(id) on delete set null,
  add column if not exists sender_address_snapshot jsonb;

comment on column public.direct_mail_campaigns.sender_address_snapshot is
  'The inline Lob `from` the pieces were mailed with (name, lines, city, state, zip), its tenant source (mailing-cass-gate.ts SenderAddressSource) and its CASS evidence. Never the platform''s address (wave 151, lane 151H).';

-- Read-back (the integrator ran it 2026-11-09: 21 columns · 2 campaign columns · 2 CHECKs · 2 policies · indexes pkey + default_uq + tenant_idx · FKs brokerage / approved_by / created_by + direct_mail_campaigns_sender_address_id_fkey):
--   select column_name from information_schema.columns where table_schema='public' and table_name='direct_mail_sender_addresses';  -- expect 21 rows (id … updated_at)
--   select column_name from information_schema.columns where table_schema='public' and table_name='direct_mail_campaigns'
--     and column_name in ('sender_address_id','sender_address_snapshot');                                                           -- expect 2 rows
--   select conname from pg_constraint where conname in ('direct_mail_sender_addresses_scope_type_check','direct_mail_sender_addresses_status_check'); -- expect 2
--   select policyname from pg_policies where tablename = 'direct_mail_sender_addresses';                                            -- expect 2

commit;
