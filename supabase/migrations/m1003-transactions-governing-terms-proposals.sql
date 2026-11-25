-- m1003 (wave 156, lane 156E) — WRITTEN, NOT APPLIED. Additive and idempotent: one NULLABLE jsonb column, no default, no
-- backfill, no index, no trigger, no policy change.
--
-- INTENT. A model may not rewrite a deal's governing terms (directive "Prohibited shortcuts"). Extracted contract terms become a
-- PROPOSAL kept on the deal with the source they came from; a deal-desk seat accepts each field through
-- app/actions/governing-terms.ts confirmGoverningTermsAction. This column is that proposal store
-- (lib/documents/governing-terms-proposal.ts is its one writer and reader).
--
-- WHY A NEW COLUMN. client_documents.ai_metadata holds an uploaded document's AI output, but a contract PASTED on the
-- contract-review screen has no document row (client_documents.document_url is NOT NULL), and one store per function
-- (CLAUDE.md §6) means both sources share one place: the deal.
--
-- SHAPE (an array; NULL = none):
--   [{ id, source: { kind: 'client_document', document_id, document_name } | { kind: 'pasted_contract_text', sha256, excerpt },
--      proposed_by (users.id), proposed_at, fields: { purchase_price | close_date | property_address | inspection_deadline |
--      appraisal_deadline | financing_deadline: value }, decisions: { <field>: { decision: 'accepted' | 'dismissed', by, at } } }]
--
-- TENANCY. The column rides public.transactions' existing row security (brokerage_id); the application writes it only on the
-- service client after the deal desk (or, for a proposal, the document's own uploader), pinned to the deal and its tenant.
--
-- UNTIL APPLIED: the proposal write is refused by the data API (PGRST204); the refusal is read and returned, and the deal is
-- unchanged. After applying, regenerate scripts/schema-snapshot.ts (the integrator).

alter table public.transactions add column if not exists governing_terms_proposals jsonb;

comment on column public.transactions.governing_terms_proposals is
  'Wave 156 (156E): AI-extracted contract terms proposed for this deal, per source, with per-field accept/dismiss decisions. Applied only by a deal-desk seat (app/actions/governing-terms.ts).';

-- Readback (expect one row: governing_terms_proposals | jsonb | YES):
-- select column_name, data_type, is_nullable from information_schema.columns
--  where table_schema = 'public' and table_name = 'transactions' and column_name = 'governing_terms_proposals';
