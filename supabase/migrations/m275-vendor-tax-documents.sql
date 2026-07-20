-- m275 — VENDOR W-9 ON FILE (owner round 43).
--
-- Vendors invoice buyers/sellers and receive payouts (rounds 34/37), which makes
-- the tenant a PAYER with 1099 reporting obligations — and round 42's audit found
-- no W-9/tax-doc capture anywhere (vendors.compliance_credentials holds
-- verification creds only). ONE small table holds the vendor's tax-doc posture:
-- the CERTIFIED record is the signed W-9 PDF itself, uploaded through the
-- EXISTING client-documents rail (storage bucket 'client-documents' +
-- client_documents row, document_type 'vendor_w9'); this table stores the doc
-- reference plus the structured basics needed to know WHO certified WHAT and
-- WHEN — never the TIN.
--
-- TIN POSTURE (deliberate): only tin_type (EIN vs SSN) is stored. The TIN itself
-- lives ONLY inside the uploaded PDF — the client-documents rail stores files in
-- a non-public bucket behind tenant scoping; no general/plain column ever holds
-- a TIN, so a table read can never leak one. scripts/vendor-w9-simulator.ts
-- grep-locks this.
--
-- STATUS VOCABULARY: 'missing' | 'on_file' | 'expired'. A W-9 does not age out
-- on a clock — it expires when the vendor's legal identity changes after filing.
-- vendor_name_at_filing snapshots vendors.name at upload; the read path derives
-- 'expired' when vendors.name has since changed (lib/vendors/w9.ts
-- deriveW9Status), so the stored status can never silently go stale.
--
-- reminder_last_sent_at is the dedupe anchor for the governed once-per-period
-- W-9 chase email (claim-then-send in lib/vendors/w9.ts).

create table if not exists vendor_tax_documents (
  id                     uuid primary key default gen_random_uuid(),
  brokerage_id           uuid not null,
  vendor_id              uuid not null unique references vendors(id) on delete cascade,

  -- The certified record: the signed W-9 PDF on the EXISTING doc rail.
  client_document_id     uuid,          -- client_documents.id of the uploaded W-9
  document_url           text,          -- storage URL of the PDF (client-documents bucket)

  -- Structured basics stored alongside (W-9 lines 1–3 + certification date).
  legal_name             text,          -- W-9 line 1 as filed
  business_type          text check (business_type in (
                           'individual_sole_proprietor','c_corporation','s_corporation',
                           'partnership','trust_estate','llc','other'
                         )),
  tin_type               text check (tin_type in ('ein','ssn')),  -- TYPE ONLY — the TIN itself is never stored
  signature_date         date,

  -- Filing-time snapshot for honest expiry derivation (legal identity change).
  vendor_name_at_filing  text,

  status                 text not null default 'missing'
                           check (status in ('missing','on_file','expired')),

  -- Governed reminder dedupe anchor (once per period; claim-then-send).
  reminder_last_sent_at  timestamptz,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists idx_vendor_tax_documents_brokerage
  on vendor_tax_documents (brokerage_id);
create index if not exists idx_vendor_tax_documents_status
  on vendor_tax_documents (brokerage_id, status);

alter table vendor_tax_documents enable row level security;

-- The vendor sees their own tax-doc row (portal reads ride the user session).
drop policy if exists "vendor reads own tax doc" on vendor_tax_documents;
create policy "vendor reads own tax doc" on vendor_tax_documents
  for select using (
    exists (
      select 1 from user_role_assignments ura
      where ura.user_id = auth.uid()
        and ura.vendor_id = vendor_tax_documents.vendor_id
    )
  );

-- Brokerage staff see W-9 posture for their tenant's vendors (console badge).
drop policy if exists "brokerage reads vendor tax docs" on vendor_tax_documents;
create policy "brokerage reads vendor tax docs" on vendor_tax_documents
  for select using (
    exists (
      select 1 from users u
      where u.id = auth.uid()
        and u.brokerage_id = vendor_tax_documents.brokerage_id
    )
  );

-- Writes go through the service-role server actions (upload + reminder stamp) —
-- no anon/authenticated insert/update/delete policies on purpose.

comment on table vendor_tax_documents is
  'Vendor W-9 posture per vendor (owner round 43). The certified record is the signed W-9 PDF on the client-documents rail (client_document_id/document_url); this row stores structured basics only — legal_name, business_type (W-9 line-3 enum), tin_type (EIN|SSN — the TIN itself is NEVER stored in any column), signature_date, and a filing-time vendor-name snapshot for honest expiry derivation. status: missing|on_file|expired. reminder_last_sent_at dedupes the governed once-per-period W-9 chase.';
