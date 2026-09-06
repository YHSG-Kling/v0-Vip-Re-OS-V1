-- m474 — ONE BILLING PERIOD VOCABULARY (#190).
--
-- usage_counters rows were written under two period spellings. The canonical
-- convention is the one the database itself computes in v_brokerage_ai_quota:
-- UTC calendar month, half-open [1st 00:00Z, next 1st 00:00Z). The app-side
-- writer (lib/usage.ts incrementUsage) stamped LOCAL months with an INCLUSIVE
-- end (last-day 23:59:59) — and because period_end is part of the UNIQUE key
-- and the quota view JOINS on it, a row written by the app was UNREADABLE by
-- the AI cap: tokens metered to a row nothing read, quota zero forever.
--
-- The app is fixed to the canonical convention (lib/usage/period.ts); this
-- migration normalises the rows already written under the old spelling.
-- MEASURED before writing: exactly ONE live row
-- (2026-07-01 00:00:00 -> 2026-07-31 23:59:59).
do $$
declare n int;
begin
  update public.usage_counters
  set period_end = date_trunc('month', period_start) + interval '1 mon'
  where period_end <> date_trunc('month', period_start) + interval '1 mon';
  get diagnostics n = row_count;
  raise notice 'm474: normalised % usage_counters row(s)', n;

  -- Postcondition: every row now carries the canonical half-open month.
  select count(*) into n from public.usage_counters
  where period_start <> date_trunc('month', period_start)
     or period_end   <> date_trunc('month', period_start) + interval '1 mon';
  if n <> 0 then
    raise exception 'm474: % rows still off the canonical period', n;
  end if;
end $$;
