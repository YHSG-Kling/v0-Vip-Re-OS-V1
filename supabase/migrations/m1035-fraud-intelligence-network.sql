-- m1035 — REAL ESTATE TRUST & FRAUD INTELLIGENCE NETWORK (wave 156, lane 156J; directive 156J, owner decision 10).
--
-- WRITTEN, NOT APPLIED. Additive and idempotent: nine NEW tables, their indexes, row security and the one session policy.
-- Nothing existing is altered, dropped or narrowed. The integrator applies it, then runs `npm run schema:regen`
-- (live-tables, schema-snapshot, schema-fk-map, check-vocabularies) so check-vocabulary-guard holds the CHECKs below
-- against lib/fraud-network/network.ts (FRAUD_TYPOLOGY_KINDS, FRAUD_CLAIM_CLASSES, … — one vocabulary, CLAUDE.md §6).
--
-- INTENT. Two records, never one accusation:
--   A. fraud_incident_cases — a PRIVATE incident case owned by the reporting tenant (brokerage_id NOT NULL). Readable only
--      through the session-gated doors of app/actions/fraud-network.ts: the reporter, the tenant's case reviewers, and
--      platform safety staff (platform_role with the `support` capability). Its evidence (fraud_case_evidence) is a FILE
--      FINGERPRINT plus kind and label — no file is stored until the owner creates a private bucket (OWNER SQL, report §7).
--   B. fraud_bulletins — a shared warning about a TACTIC, never a person. It is PLATFORM-OWNED and carries NO tenant column
--      on purpose: a tenant column on a row every tenant can read would expose who reported it. The link from a bulletin to
--      the private cases it was drawn from lives in fraud_bulletin_sources (tenant-owned, server-only), which cascades away
--      when the tenant or the case goes — a departed tenant's cases are never reachable through a retained bulletin.
--      A named entity may appear ONLY with claim_class = 'official_public_warning', an authoritative citation URL and a
--      platform-staff legal-review stamp — enforced here (CHECK) and in the publish door.
--
-- ROW SECURITY. Every table has RLS enabled. Only fraud_bulletins has a session policy: authenticated TENANT SEATS may
-- SELECT a row only while status = 'published' (the seat list equals FRAUD_NETWORK_PARTICIPANT_USER_TYPES in
-- lib/fraud-network/network.ts; scripts/wave156-j-guard.ts holds the two equal). Every other table has NO session policy —
-- only the service role reaches it, through doors that gate first and pin the tenant (the circle_tactic_shares posture,
-- m973). No session INSERT / UPDATE / DELETE policy exists on any of the nine tables: writes go through the service door.
--
-- NOT HERE (owner-held): a storage bucket for evidence files and its storage.objects policies; retention length
-- (FRAUD_CASE_RETENTION_DAYS is a code default counsel must confirm); the community posting rules
-- (docs/legal/PACKET-7-FRAUD-COMMUNITY-POSTING-RULES.md, DRAFT — NOT PUBLISHED).

-- ── A. Private incident cases ──────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.fraud_incident_cases (
  id                   uuid primary key default gen_random_uuid(),
  brokerage_id         uuid not null references public.brokerages(id) on delete cascade,
  reporter_user_id     uuid not null references public.users(id) on delete cascade,
  transaction_id       uuid references public.transactions(id) on delete set null,
  listing_id           uuid references public.listings(id) on delete set null,
  incident_kind        text not null check (incident_kind in (
                         'wire_diversion_lookalike_domain', 'change_of_wire_instructions', 'vacant_land_seller_impersonation',
                         'deed_ownership_impersonation', 'fake_rental_deposit', 'fake_listing_photo_reuse',
                         'cloned_title_escrow_attorney_identity', 'fake_lender_insurance_communication',
                         'vendor_invoice_substitution', 'credential_phishing', 'forged_power_of_attorney',
                         'fake_earnest_money_instructions', 'altered_payoff_settlement_documents',
                         'professional_recruitment_investment_scam')),
  event_date           date,
  channel              text not null check (channel in ('email', 'text_message', 'phone_call', 'video_call', 'social_media', 'listing_site', 'e_sign_platform', 'postal_mail', 'in_person', 'other')),
  summary              text not null check (char_length(summary) between 1 and 4000),
  alleged_indicators   jsonb not null default '[]'::jsonb,
  loss_occurred        text not null default 'unknown' check (loss_occurred in ('yes', 'no', 'unknown')),
  loss_amount          numeric(14,2) check (loss_amount is null or loss_amount >= 0),
  steps_taken          text,
  external_report_ids  jsonb not null default '[]'::jsonb,
  status               text not null default 'submitted' check (status in ('submitted', 'under_review', 'used_for_bulletin', 'closed_no_action', 'withdrawn')),
  moderation_notes     jsonb not null default '[]'::jsonb,
  dispute              jsonb,
  share_consent        boolean not null default false,
  retention_until      timestamptz not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists fraud_incident_cases_brokerage_idx on public.fraud_incident_cases (brokerage_id, created_at desc);
create index if not exists fraud_incident_cases_reporter_idx on public.fraud_incident_cases (reporter_user_id, created_at desc);
create index if not exists fraud_incident_cases_status_idx on public.fraud_incident_cases (status, created_at);
create index if not exists fraud_incident_cases_retention_idx on public.fraud_incident_cases (retention_until);
alter table public.fraud_incident_cases enable row level security;

create table if not exists public.fraud_case_evidence (
  id                 uuid primary key default gen_random_uuid(),
  brokerage_id       uuid not null references public.brokerages(id) on delete cascade,
  case_id            uuid not null references public.fraud_incident_cases(id) on delete cascade,
  evidence_kind      text not null check (evidence_kind in ('screenshot', 'email_headers', 'document', 'message_export', 'audio_recording', 'payment_record', 'listing_capture', 'other')),
  fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  label              text check (label is null or char_length(label) <= 200),
  storage_status     text not null default 'not_stored' check (storage_status in ('not_stored', 'stored')),
  created_by         uuid references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  constraint fraud_case_evidence_case_fingerprint_key unique (case_id, fingerprint_sha256)
);
create index if not exists fraud_case_evidence_brokerage_idx on public.fraud_case_evidence (brokerage_id);
create index if not exists fraud_case_evidence_fingerprint_idx on public.fraud_case_evidence (fingerprint_sha256);
alter table public.fraud_case_evidence enable row level security;

-- ── B. Shared bulletins (platform-owned; no tenant column by design) ─────────────────────────────────────────────────
create table if not exists public.fraud_bulletins (
  id                        uuid primary key default gen_random_uuid(),
  typology                  text not null check (typology in (
                              'wire_diversion_lookalike_domain', 'change_of_wire_instructions', 'vacant_land_seller_impersonation',
                              'deed_ownership_impersonation', 'fake_rental_deposit', 'fake_listing_photo_reuse',
                              'cloned_title_escrow_attorney_identity', 'fake_lender_insurance_communication',
                              'vendor_invoice_substitution', 'credential_phishing', 'forged_power_of_attorney',
                              'fake_earnest_money_instructions', 'altered_payoff_settlement_documents',
                              'professional_recruitment_investment_scam')),
  title                     text not null check (char_length(title) between 1 and 200),
  tactic_summary            text not null check (char_length(tactic_summary) between 1 and 4000),
  indicators                jsonb not null default '[]'::jsonb,
  red_flags                 jsonb not null default '[]'::jsonb,
  how_to_verify             text not null,
  source_url                text,
  jurisdiction              text,
  recency_date              date,
  confidence                text not null check (confidence in ('low', 'medium', 'high')),
  claim_class               text not null check (claim_class in ('unverified_report', 'verified_operational_pattern', 'official_public_warning')),
  named_entity              text,
  named_entity_citation_url text,
  legal_review_by           uuid references public.users(id) on delete set null,
  legal_review_at           timestamptz,
  status                    text not null default 'draft' check (status in ('draft', 'published', 'taken_down')),
  version                   integer not null default 1 check (version >= 1),
  created_by                uuid references public.users(id) on delete set null,
  published_by              uuid references public.users(id) on delete set null,
  published_at              timestamptz,
  taken_down_at             timestamptz,
  takedown_reason           text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  -- A named entity only as a faithful, sourced official description after human legal review.
  constraint fraud_bulletins_named_entity_rule check (
    named_entity is null
    or (claim_class = 'official_public_warning' and named_entity_citation_url is not null and legal_review_by is not null and legal_review_at is not null)
  )
);
create index if not exists fraud_bulletins_status_idx on public.fraud_bulletins (status, published_at desc);
create index if not exists fraud_bulletins_typology_idx on public.fraud_bulletins (typology, status);
alter table public.fraud_bulletins enable row level security;
drop policy if exists fraud_bulletins_published_read on public.fraud_bulletins;
create policy fraud_bulletins_published_read on public.fraud_bulletins
  for select to authenticated
  using (
    status = 'published'
    and public.current_user_brokerage_id() is not null
    and coalesce(public.current_user_type(), '') in ('admin', 'agent', 'broker', 'broker_admin', 'broker_owner', 'compliance_officer', 'isa', 'tc', 'team_lead')
  );

-- The corroboration ledger: which tenant's case (with which evidence fingerprint) a bulletin was drawn from.
-- Independent corroboration = distinct tenants with distinct fingerprints, never a count of rows, clicks or reads.
create table if not exists public.fraud_bulletin_sources (
  id                   uuid primary key default gen_random_uuid(),
  brokerage_id         uuid not null references public.brokerages(id) on delete cascade,
  bulletin_id          uuid not null references public.fraud_bulletins(id) on delete cascade,
  case_id              uuid not null references public.fraud_incident_cases(id) on delete cascade,
  evidence_fingerprint text check (evidence_fingerprint is null or evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  linked_by            uuid references public.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  constraint fraud_bulletin_sources_bulletin_case_key unique (bulletin_id, case_id)
);
create index if not exists fraud_bulletin_sources_brokerage_idx on public.fraud_bulletin_sources (brokerage_id);
create index if not exists fraud_bulletin_sources_bulletin_idx on public.fraud_bulletin_sources (bulletin_id);
alter table public.fraud_bulletin_sources enable row level security;

-- Correction history: every publish / correction / takedown keeps the PREVIOUS text (versioned, never overwritten).
create table if not exists public.fraud_bulletin_revisions (
  id            uuid primary key default gen_random_uuid(),
  bulletin_id   uuid not null references public.fraud_bulletins(id) on delete cascade,
  version       integer not null,
  change_kind   text not null check (change_kind in ('published', 'corrected', 'taken_down')),
  snapshot      jsonb not null,
  reason        text not null,
  correction_request_id uuid,
  actor_user_id uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists fraud_bulletin_revisions_bulletin_idx on public.fraud_bulletin_revisions (bulletin_id, version);
alter table public.fraud_bulletin_revisions enable row level security;

-- Correction / dispute channel — for a named subject (received through Support or by mail / phone and recorded by staff)
-- and for tenants (in-app). brokerage_id is the requesting TENANT when there is one; a named subject has none.
create table if not exists public.fraud_correction_requests (
  id                 uuid primary key default gen_random_uuid(),
  bulletin_id        uuid not null references public.fraud_bulletins(id) on delete cascade,
  requester_kind     text not null check (requester_kind in ('named_subject', 'tenant')),
  brokerage_id       uuid references public.brokerages(id) on delete cascade,
  requester_user_id  uuid references public.users(id) on delete set null,
  channel            text not null check (channel in ('in_app', 'support_ticket', 'email', 'phone', 'postal_mail')),
  support_ticket_id  uuid references public.support_tickets(id) on delete set null,
  statement          text not null check (char_length(statement) between 1 and 4000),
  status             text not null default 'received' check (status in ('received', 'corrected', 'taken_down', 'rejected')),
  resolution         text,
  resolved_by        uuid references public.users(id) on delete set null,
  resolved_at        timestamptz,
  recorded_by        uuid references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  constraint fraud_correction_requests_tenant_iff check ((requester_kind = 'tenant') = (brokerage_id is not null))
);
create index if not exists fraud_correction_requests_bulletin_idx on public.fraud_correction_requests (bulletin_id, status);
create index if not exists fraud_correction_requests_brokerage_idx on public.fraud_correction_requests (brokerage_id) where brokerage_id is not null;
alter table public.fraud_correction_requests enable row level security;

-- Location / type warning subscriptions (null = every typology / every jurisdiction).
create table if not exists public.fraud_warning_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  brokerage_id uuid not null references public.brokerages(id) on delete cascade,
  user_id      uuid not null references public.users(id) on delete cascade,
  typology     text,
  jurisdiction text,
  created_at   timestamptz not null default now()
);
create unique index if not exists fraud_warning_subscriptions_key on public.fraud_warning_subscriptions (user_id, coalesce(typology, ''), coalesce(jurisdiction, ''));
create index if not exists fraud_warning_subscriptions_brokerage_idx on public.fraud_warning_subscriptions (brokerage_id);
alter table public.fraud_warning_subscriptions enable row level security;

-- Measured reads (metric "bulletins read"): one row per seat per bulletin.
create table if not exists public.fraud_bulletin_reads (
  id            uuid primary key default gen_random_uuid(),
  brokerage_id  uuid not null references public.brokerages(id) on delete cascade,
  user_id       uuid not null references public.users(id) on delete cascade,
  bulletin_id   uuid not null references public.fraud_bulletins(id) on delete cascade,
  first_read_at timestamptz not null default now(),
  constraint fraud_bulletin_reads_user_bulletin_key unique (user_id, bulletin_id)
);
create index if not exists fraud_bulletin_reads_bulletin_idx on public.fraud_bulletin_reads (bulletin_id);
alter table public.fraud_bulletin_reads enable row level security;

-- Derived copies: the tenant topic-pool rows a bulletin fed (so a takedown can withdraw them).
create table if not exists public.fraud_bulletin_derivatives (
  id           uuid primary key default gen_random_uuid(),
  brokerage_id uuid not null references public.brokerages(id) on delete cascade,
  bulletin_id  uuid not null references public.fraud_bulletins(id) on delete cascade,
  topic_id     uuid not null references public.content_topic_bank(id) on delete cascade,
  created_at   timestamptz not null default now(),
  constraint fraud_bulletin_derivatives_key unique (bulletin_id, topic_id)
);
create index if not exists fraud_bulletin_derivatives_brokerage_idx on public.fraud_bulletin_derivatives (brokerage_id);
alter table public.fraud_bulletin_derivatives enable row level security;

comment on table public.fraud_incident_cases is 'Wave 156 (156J): a tenant''s PRIVATE fraud incident case. Server-only (no session policy); doors in app/actions/fraud-network.ts.';
comment on table public.fraud_bulletins is 'Wave 156 (156J): a shared warning about a fraud TACTIC. Platform-owned, no tenant column; tenant seats read only published rows.';

-- Read-back the integrator runs after applying:
--   select tablename, rowsecurity from pg_tables where schemaname = 'public' and tablename like 'fraud\_%' order by 1;   -- 9 rows, all true
--   select tablename, policyname, cmd from pg_policies where schemaname = 'public' and tablename like 'fraud\_%';       -- exactly 1: fraud_bulletins_published_read SELECT
--   select conname from pg_constraint where conrelid = 'public.fraud_bulletins'::regclass and contype = 'c' order by 1;  -- includes fraud_bulletins_named_entity_rule
