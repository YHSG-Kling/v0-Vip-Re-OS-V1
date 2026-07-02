-- m259 — Team P&L writer idempotency indexes.
--
-- team_earnings / team_performance were READ by the reporting layer (generateTeamPerformanceReport)
-- but had NO production writer (table-with-no-writer drift), so every team dashboard read empty. The
-- new Team P&L writer (lib/finance/team-pl-writer.ts, finance_manager) rolls up the canonical
-- agent_commissions per team's active members and upserts one row per team per period. These unique
-- indexes give the upserts their conflict targets so a nightly re-run is idempotent.
--
-- period_type is CHECK-constrained to mtd/ytd/all_time; the monthly running total is written as 'mtd'
-- keyed by the YYYY-MM period_label.

create unique index if not exists uq_team_earnings_team_period
  on public.team_earnings (team_id, period_type, period_label);

create unique index if not exists uq_team_performance_team_period
  on public.team_performance (team_id, period_label);
