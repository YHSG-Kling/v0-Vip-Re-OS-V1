-- ── APPLIED LIVE 2026-11-14 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 153, lane 153B ── read back: 5 columns, anchor + record checks, 3 FKs, listing index
--
-- PRE-CLOSE COMMISSION TERM CHANGES ON THE EXISTING COMMISSION LEDGER (owner ruling 4, 2026-11-14: "anyone attached to the
-- offer/listing/transaction that holds a seat or admin can change commission terms but not after a transaction has closed").
--
-- CENSUS (read-only, 2026-11-14, project hrvaqgvukzxfskkcrwbt): public.commission_adjustments already carries the approval
-- state machine (m850: approval_status requested / approved / denied / withdrawn / not_required + decided_at / decided_by /
-- note / policy_ref) and its mechanism CHECK already admits 'rate_override' — with ZERO rows and NO writer. It is the survivor
-- for "a governed change to a deal's commission rate" (lib/commission/commission-term-change.ts is its one writer). No new table.
-- Live rows: commission_adjustments 0, transactions 2 (none closed) — nothing to backfill.
--
-- WHAT THE RECORD LACKED (directive 153B: "capture actor, requested changes, reason, effective date, associated executed
-- evidence, calculated before/after values, approvals … idempotency key"):
--   · listing_id            — a LISTING anchor: a change requested on a listing before any offer or transaction exists
--                             (the anchor CHECK widens from transaction | offer to transaction | offer | listing);
--   · requested_by_user_id  — WHO asked (a TC, a team lead or an admin has no agents row, so created_by_agent_id cannot say);
--   · prior_value           — the governing value the request was made against (the version a decision is checked against:
--                             a request whose prior value no longer matches the deal is a CONFLICT, never silently applied);
--   · evidence_document_id  — the executed amendment / agreement the change rests on when an executed agreement governs;
--   · applied_at            — when the governing term actually moved (a proposal is not an applied change).
-- Reason = notes, effective date = effective_date, approvals = the m850 columns, idempotency = agent_action_ledger
-- (withActionLedger's unique idempotency_key) — all existing.
--
-- No new CHECK vocabulary (adjustment_type already admits rate_override). The record check below is a rule, not a value list.
--
-- VERIFY after applying:
--   select column_name from information_schema.columns where table_schema='public' and table_name='commission_adjustments'
--     and column_name in ('listing_id','requested_by_user_id','prior_value','evidence_document_id','applied_at');   -- 5 rows
--   select pg_get_constraintdef(oid) from pg_constraint where conname in
--     ('commission_adjustments_anchor_check','commission_adjustments_term_change_record_check');                    -- 2 rows
-- Then regenerate scripts/schema-snapshot.ts and scripts/schema-fk-map.ts (generated caches; never hand-edited).
--
-- ROLLBACK (the column drops are owner SQL — docs/operations/OWNER-SQL.md):
--   alter table public.commission_adjustments drop constraint if exists commission_adjustments_term_change_record_check;
--   alter table public.commission_adjustments drop constraint if exists commission_adjustments_anchor_check;
--   alter table public.commission_adjustments add constraint commission_adjustments_anchor_check
--     check (transaction_id is not null or offer_id is not null);   -- only once no row is listing-anchored
--   drop index if exists public.commission_adjustments_listing_id_idx;
--   alter table public.commission_adjustments drop column if exists listing_id, drop column if exists requested_by_user_id,
--     drop column if exists prior_value, drop column if exists evidence_document_id, drop column if exists applied_at;

alter table public.commission_adjustments
  add column if not exists listing_id uuid references public.listings(id) on delete cascade,
  add column if not exists requested_by_user_id uuid references public.users(id),
  add column if not exists prior_value numeric,
  add column if not exists evidence_document_id uuid references public.documents(id) on delete set null,
  add column if not exists applied_at timestamptz;

alter table public.commission_adjustments drop constraint if exists commission_adjustments_anchor_check;
alter table public.commission_adjustments add constraint commission_adjustments_anchor_check
  check (transaction_id is not null or offer_id is not null or listing_id is not null);

-- A term change always names who asked, and its prior value is never negative (value_check already holds the new value >= 0).
alter table public.commission_adjustments drop constraint if exists commission_adjustments_term_change_record_check;
alter table public.commission_adjustments add constraint commission_adjustments_term_change_record_check
  check (adjustment_type <> 'rate_override' or (requested_by_user_id is not null and (prior_value is null or prior_value >= 0)));

create index if not exists commission_adjustments_listing_id_idx
  on public.commission_adjustments (listing_id) where listing_id is not null;
