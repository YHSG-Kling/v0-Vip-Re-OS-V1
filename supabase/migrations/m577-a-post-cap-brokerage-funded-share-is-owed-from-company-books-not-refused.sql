-- m577-a-post-cap-brokerage-funded-share-is-owed-from-company-books-not-refused.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- THE COMPANY-BOOKS PAYABLES LEDGER — where a brokerage-funded share lands when
-- the deal that triggered it has no company dollar to fund it.
--
-- WRITTEN 2026-08-28, NOT APPLIED (integrator applies; lanes only write).
-- After applying: regenerate the schema caches (schema-snapshot.ts,
-- schema-fk-map.ts, live-tables.ts) AND the vocabulary cache
-- (check-vocabularies.ts) — this migration adds CHECK constraints (§3).
--
-- OWNER RULING (2026-08-28, verbatim): "usually when a cap is met, the
-- brokerage no longer takes from the agents if the agent has splits with a cap
-- as a commission level offering." The cap ends the brokerage TAKING from the
-- agent — stage 07 zeroes the brokerage's in-deal final. It does not end the
-- brokerage PAYING its own obligations: a brokerage-funded revenue share
-- (brokerages.revenue_share_source_of_funds = 'brokerage', m575 — "the
-- brokerage pays the share") is the COMPANY's promise to its sponsor network,
-- not a deduction from the producing agent.
--
-- WHAT HAPPENED BEFORE THIS MIGRATION: on a post-cap closing the brokerage's
-- in-deal final is $0, so computeRevenueShare's brokerage-side overdraft check
-- THREW — the producing agent's ENTIRE commission failed over the brokerage's
-- own side-obligation (strictly better than the pre-m575 crash, but it treated
-- a real business case — a capped, producing, sponsored downline — as an
-- error). The share could be neither paid in-deal (no money in the deal) nor
-- recorded anywhere else (no company-side payables ledger existed).
--
-- WHY A NEW TABLE, not a commission_distributions row (§1.2 — the missing half
-- is BUILT because no duplicate exists):
--   · commission_distributions is the IN-DEAL disbursement ledger, and both
--     payment sweeps treat every row on it as paid by the DEAL's disbursement:
--     payment-tracker.markCommissionPaid updates every row by commission_id,
--     and reconcile-tracking's orphan lock updates every non-terminal row by
--     transaction_id + NULL commission_id. A company-books payable is NOT paid
--     by the deal's disbursement — parking it there would stamp it 'paid' the
--     moment the deal pays, a false record on a money ledger.
--   · Step 11's conservation identity (gross == distributed + finals) sums the
--     deal's distribution rows. An obligation funded OUTSIDE the deal must not
--     be in that identity; a marker column on commission_distributions would
--     force every sweep and every checker to learn a filter, and pre-apply the
--     filter itself would 42703-refuse the sweeps that keep the existing
--     ledger honest.
--   · No existing table is a company payables ledger: brokerage_earnings and
--     agent_earnings are delete-then-insert rollup SNAPSHOTS (a row written
--     there is erased on the next rollup pass), business_expenses has no
--     recipient/payment lifecycle, and transaction_commissions is the deal's
--     own stamp.
--
-- VOCABULARY (§6 — every word reused from the ledgers that already exist):
--   obligation_type   'residual' — commission_distributions.distribution_type's
--                     word for revenue share. Widened only when a new share
--                     class is ruled onto company books.
--   calculation_type  'flat' | 'percent' — the repo's rate-type pair.
--   calculated_amount dollars — commission_distributions' amount column name.
--   cap_status        commission_distributions.cap_status's exact set; records
--                     the cap state of the TRIGGERING deal ('post_cap' for the
--                     capped case, 'hit_cap' for a straddling deal whose
--                     remaining company dollar was smaller than the share).
--   status            'pending' | 'approved' | 'paid' | 'voided' —
--                     commission_distributions.status's exact set.
--   reason            'post_cap_company_books' — WHY this is on company books.
--                     One value today; the CHECK admits only what is written.
--
-- WRITER: lib/commission/waterfall/11-validate-persist.ts (service client) —
-- idempotent per transaction (replaces this deal's still-PENDING rows on a
-- re-run; paid/voided rows are payment history and are never touched), counted
-- per §3, and a refused write THROWS (never a silently dropped obligation).
-- agent_id is the RECIPIENT (the sponsor) and is an agents.id — the same id
-- class commission_distributions.agent_id carries (§3: agents.id and users.id
-- are disjoint).

create table if not exists public.company_books_obligations (
  id                  uuid primary key default gen_random_uuid(),
  brokerage_id        uuid not null references public.brokerages(id)   on delete cascade,
  -- The TRIGGERING deal, for audit — the money does not come from it.
  transaction_id      uuid          references public.transactions(id) on delete set null,
  -- RECIPIENT (the sponsor). agents.id, like commission_distributions.agent_id.
  agent_id            uuid not null references public.agents(id)       on delete cascade,
  obligation_type     text not null,
  calculation_type    text not null,
  calculation_value   numeric,
  calculated_amount   numeric(12,2) not null,
  reason              text not null,
  cap_status          text,
  status              text not null default 'pending',
  paid_at             timestamptz,
  voided_at           timestamptz,
  voided_reason       text,
  calculation_version integer,
  created_at          timestamptz not null default now(),
  constraint company_books_obligations_type_check
    check (obligation_type in ('residual')),
  constraint company_books_obligations_calc_type_check
    check (calculation_type in ('flat', 'percent')),
  constraint company_books_obligations_amount_check
    check (calculated_amount > 0),
  constraint company_books_obligations_reason_check
    check (reason in ('post_cap_company_books')),
  constraint company_books_obligations_cap_status_check
    check (cap_status is null or cap_status in ('pre_cap', 'hit_cap', 'post_cap', 'n/a')),
  constraint company_books_obligations_status_check
    check (status in ('pending', 'approved', 'paid', 'voided'))
);

create index if not exists company_books_obligations_txn_idx
  on public.company_books_obligations (transaction_id, brokerage_id, status);

create index if not exists company_books_obligations_recipient_idx
  on public.company_books_obligations (agent_id, brokerage_id, status);

alter table public.company_books_obligations enable row level security;

-- READ: tenant-wide — the sponsor must be able to see what they are owed (it is
-- their own income, §5: their OWN economics, not the producing agent's
-- commission detail), and the broker's payables surfaces read it.
create policy company_books_obligations_tenant_select on public.company_books_obligations
  for select to authenticated
  using (brokerage_id = public.current_user_brokerage_id());

-- WRITE: a MONEY LEDGER. The engine writes on the service client (bypasses RLS);
-- session writes are administrative correction only — brokerage-admin, with the
-- tenant anchor repeated in WITH CHECK so a row cannot be moved cross-tenant
-- (the m457 lesson, as m461 applied it).
create policy company_books_obligations_admin_insert on public.company_books_obligations
  for insert to authenticated
  with check (brokerage_id = public.current_user_brokerage_id() and public.is_brokerage_admin());

create policy company_books_obligations_admin_update on public.company_books_obligations
  for update to authenticated
  using (brokerage_id = public.current_user_brokerage_id() and public.is_brokerage_admin())
  with check (brokerage_id = public.current_user_brokerage_id() and public.is_brokerage_admin());

create policy company_books_obligations_admin_delete on public.company_books_obligations
  for delete to authenticated
  using (brokerage_id = public.current_user_brokerage_id() and public.is_brokerage_admin());

comment on table public.company_books_obligations is
  'Company-side payables: money the brokerage owes from its OWN books, recorded when a brokerage-funded share (m575 revenue share) lands on a deal whose company dollar cannot fund it — post-cap the in-deal brokerage final is $0 (owner ruling 2026-08-28: the cap ends the brokerage TAKING from the agent, not the brokerage PAYING its own obligations). Deliberately NOT commission_distributions: rows here are outside the deal''s gross == distributed + finals identity and outside the deal''s disbursement sweeps. Written by the commission waterfall step 11 (idempotent per transaction, counted, refusals thrown).';
comment on column public.company_books_obligations.agent_id is
  'RECIPIENT (the sponsor being paid) — agents.id, the same id class as commission_distributions.agent_id.';
comment on column public.company_books_obligations.transaction_id is
  'The TRIGGERING deal, for audit. The money does not come from this deal — that is the point of the table.';
comment on column public.company_books_obligations.reason is
  'Why this obligation is on company books instead of in the deal. ''post_cap_company_books'': the deal''s remaining company dollar (post-cap: $0) could not fund the share.';
comment on column public.company_books_obligations.cap_status is
  'The triggering deal''s cap state when the obligation arose (commission_distributions.cap_status''s vocabulary): ''post_cap'' for a capped deal, ''hit_cap'' for a straddling deal whose remaining dollar was smaller than the share.';
