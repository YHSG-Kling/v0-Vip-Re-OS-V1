-- m387 — three owner rulings, one DDL.
--
-- 1. CONTRACT TERMS ON THE TRANSACTION. Waves 10 and 11 recorded, honestly,
--    that these terms are read off the executed contract onto `offers` and then
--    DROPPED at the offer→transaction bridge because no column existed to hold
--    them. The names match `offers` exactly so the bridge copies 1:1 and no
--    second vocabulary is created.
alter table public.transactions
  add column if not exists financing_type            text,
  add column if not exists down_payment_amount       numeric,
  add column if not exists down_payment_percent      numeric,
  add column if not exists closing_cost_contribution numeric,
  add column if not exists possession_terms          text,
  add column if not exists escalation_clause         boolean,
  add column if not exists escalation_cap            numeric,
  add column if not exists appraisal_gap             numeric,
  add column if not exists due_diligence_fee         numeric,
  add column if not exists inspection_period_days    integer,
  add column if not exists appraisal_contingency_days integer,
  add column if not exists financing_contingency_days integer;

comment on column public.transactions.financing_type is
  'Copied from offers.financing_type at the offer -> transaction bridge. The executed contract term, not an estimate.';
comment on column public.transactions.possession_terms is
  'Copied from offers.possession_terms. Free text as it appears on the contract.';

-- 2. THE AGENT APPROVAL THAT PUTS AN OFFER IN FRONT OF THE SELLER.
--    Owner ruling: "any offer that comes in for inside listings, ONCE AGENT
--    APPROVES, is pushed to the seller's portal". Until now the seller portal
--    read `offers` by status alone, so every inbound offer was visible to the
--    seller the instant it landed — before any agent had read it. The stamp is
--    the gate: null means the seller must not see it.
alter table public.offers
  add column if not exists presented_to_seller_at        timestamptz,
  add column if not exists presented_to_seller_by_agent_id uuid references public.agents(id) on delete set null,
  add column if not exists seller_presentation_note      text;

comment on column public.offers.presented_to_seller_at is
  'When the listing agent approved this offer for the seller portal. NULL = the seller must not see it. Set only by the approval action; never inferred from status.';
comment on column public.offers.presented_to_seller_by_agent_id is
  'agents.id of the approver (agents-class id, NOT users.id).';

create index if not exists idx_offers_presented_to_seller
  on public.offers (listing_id, presented_to_seller_at)
  where presented_to_seller_at is not null;

-- 3. ORPHANED STORAGE OBJECTS.
--    Every document lane uploads the bytes FIRST and then signs a URL; when the
--    signer fails it returns "" and the caller bails, leaving the object in the
--    bucket with no row in any ledger pointing at it. Nothing has ever swept
--    them. This is the ledger a compensating delete writes to when the delete
--    itself also fails, so an orphan is a KNOWN row rather than an invisible
--    one.
create table if not exists public.storage_orphaned_objects (
  id            uuid primary key default gen_random_uuid(),
  brokerage_id  uuid references public.brokerages(id) on delete cascade,
  bucket        text not null,
  object_path   text not null,
  reason        text not null,
  detail        text,
  detected_at   timestamptz not null default now(),
  cleanup_attempts integer not null default 0,
  last_attempt_at  timestamptz,
  cleaned_at    timestamptz,
  cleanup_error text,
  unique (bucket, object_path)
);

comment on table public.storage_orphaned_objects is
  'Storage objects whose owning database row was never created (upload succeeded, the follow-up failed). Written by the compensating delete when the delete itself fails; swept by the storage-orphan cron. cleaned_at non-null = the object is gone from the bucket.';

create index if not exists idx_storage_orphans_uncleaned
  on public.storage_orphaned_objects (detected_at)
  where cleaned_at is null;

alter table public.storage_orphaned_objects enable row level security;

-- Service-role only: this ledger names raw object paths across every tenant and
-- has no end-user surface. No permissive policy is created, so RLS denies all
-- anon/authenticated access by default; the sweeper uses the service client.
