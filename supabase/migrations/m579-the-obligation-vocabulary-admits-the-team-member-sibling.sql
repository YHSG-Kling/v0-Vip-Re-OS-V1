-- m579 — company_books_obligations.obligation_type admits 'team_member'.
--
-- m577 built the company-books rail for the revenue-share case and its CHECK
-- deliberately admitted only 'residual'. The owner's 2026-08-28 ruling closed
-- the LAST SIBLING of that defect: a brokerage-funded team_members split on a
-- deal whose company dollar cannot fund it (post-cap: $0) now routes here too
-- (lib/commission/waterfall/08-team-split.ts), instead of being pushed as an
-- in-deal distribution deducted from nothing — which failed step 11's
-- gross == distributed + finals identity on EVERY deal carrying such a row.
-- Without this widening, step 11's fail-loud persist would 23514-refuse the
-- new obligation type.
--
-- reason vocabulary unchanged: 'post_cap_company_books' already states why the
-- money is on company books, whichever share class it carries.
alter table public.company_books_obligations
  drop constraint if exists company_books_obligations_type_check;
alter table public.company_books_obligations
  add constraint company_books_obligations_type_check
  check (obligation_type in ('residual', 'team_member'));
comment on constraint company_books_obligations_type_check on public.company_books_obligations is
  'residual = brokerage-funded revenue share (m577); team_member = brokerage-funded team split (m579) — the two share classes the deal''s company dollar can fail to fund.';
