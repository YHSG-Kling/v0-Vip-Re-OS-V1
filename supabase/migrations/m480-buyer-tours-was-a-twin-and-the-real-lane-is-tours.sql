-- m480 — BUYER_TOURS WAS A TWIN, AND THE REAL LANE IS TOURS.
--
-- OWNER RULING: an orphan that is neither called nor written anywhere and has
-- no duplicate is a feature to BUILD — and buyer tours was the named example.
-- The build landed on the CANONICAL tables (`tours` + `tour_stops`): the CRM
-- planner (app/actions/tour-planner.ts), the kernel route optimizer
-- (lib/kernel/tour-optimizer.ts, cron + voice + the optimize actions), the
-- showing-dispatch lane (app/actions/dispatch-showing.ts, now also behind the
-- bulk "Schedule Showings" step), and the buyer-portal reader
-- (app/actions/portal-tours.ts → /portal/[contactId]/showings) all read and
-- write `tours`/`tour_stops`. The capability is live end-to-end on ONE lane.
--
-- `buyer_tours` is the OTHER lane that never lived: created by
-- scripts/1027-workflow-os-schema-reconciliation.sql for a Sprint-A
-- schedule_tour adapter that was instead pointed at `tours`
-- (lib/workflow/adapters/schedule-tour.ts documents the twin explicitly:
-- "The legacy `buyer_tours` table is not used (it was write-only drift)").
--
-- READER/WRITER CENSUS before this drop (repo-wide grep, comment-aware):
--   · lib/workflow/adapters/schedule-tour.ts — prose comment only.
--   · app/dashboard/calendar/components/os/calendar-shell.tsx — the string
--     "buyer_tours" is a UI source LABEL on events read from `tours`; the
--     query targets `tours` ("correct table name is tours, not buyer_tours").
--   · scripts/agent-fk-columns.ts / schema-fk-map.ts / check-vocabularies.ts —
--     schema catalogs, not app reads/writes.
--   · m478 — listed it among tables whose dead-permissive INSERT policy was
--     closed (its own side-finding already called it "a legacy twin of tours
--     with no app writer").
--   NO app code selects from, inserts into, updates, or deletes buyer_tours.
--
-- MEASURED before writing: buyer_tours holds 0 rows; nothing FKs to it.
-- The DO block re-measures at apply time and REFUSES the drop if any row has
-- appeared — an empty twin may go, a populated one is somebody's data.

do $$
declare n bigint;
begin
  if to_regclass('public.buyer_tours') is null then
    raise notice 'm480: buyer_tours already absent — nothing to drop';
    return;
  end if;

  execute 'select count(*) from public.buyer_tours' into n;
  if n <> 0 then
    raise exception
      'm480 REFUSED: buyer_tours holds % row(s) — a populated table is not a twin to drop. Investigate the writer before retrying.', n;
  end if;

  drop table public.buyer_tours;
  raise notice 'm480: dropped empty legacy twin buyer_tours (canonical lane: tours + tour_stops)';

  -- Postcondition: the twin is gone.
  if to_regclass('public.buyer_tours') is not null then
    raise exception 'm480: buyer_tours still exists after drop';
  end if;
end $$;
