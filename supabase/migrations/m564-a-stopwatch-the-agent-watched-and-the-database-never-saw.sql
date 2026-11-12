-- m564 — A STOPWATCH THE AGENT WATCHED AND THE DATABASE NEVER SAW.
--
-- ORPHAN DOCTRINE §1.2 — no duplicate exists, the capability is wanted, so BUILD
-- the missing half.
--
-- tour_stops.time_arrived_at / time_left_at / time_spent_minutes were WRITERLESS.
-- Verified live on hrvaqgvukzxfskkcrwbt before this migration:
--
--   · information_schema.columns → all three column_default NULL,
--     is_generated 'NEVER', generation_expression NULL
--   · pg_trigger  WHERE tgrelid='public.tour_stops' AND NOT tgisinternal → 0 rows
--   · pg_proc     WHERE prosrc ILIKE '%tour_stops%' (or any of the three names) → 0 rows
--   · SELECT count(time_arrived_at), count(time_left_at), count(time_spent_minutes)
--     FROM tour_stops → 0, 0, 0 (of 0 total rows)
--
-- Their ONLY appearance in the tree was the SELECT list at
-- app/actions/tour-planner.ts:236. Nothing wrote them; nothing rendered them.
--
-- THE OWNER'S RULING settles the one open question a prior lane left unresolved:
-- showings.completed_at / duration_minutes are NOT the intended survivor —
-- "tours and showings are 2 different as showings are for showing requests or
-- showings on the tenants listings". There is no duplicate. §1.2 applies.
--
-- WHY THE DERIVATION LIVES IN THE DATABASE, NOT IN CODE
-- -----------------------------------------------------
-- time_spent_minutes was a plain nullable integer — a number any INSERT or UPDATE
-- could assert without ever having seen a clock. Making it GENERATED ALWAYS makes
-- a client-supplied duration STRUCTURALLY IMPOSSIBLE rather than merely
-- discouraged: Postgres refuses any write to the column outright (428C0), so no
-- future caller, backfill or rpc can put a minute count there that the two
-- timestamps do not support. That is a stronger guarantee than a code convention,
-- and it cannot drift from the facts it is derived from.
--
-- It also NULLs correctly for a half-recorded visit. An arrival with no departure
-- yields NULL, not 0 — "we never recorded the leave" must never launder itself
-- into "they spent no time there", the same rule
-- lib/behavior-learning/signal-mapping.ts::tourInterestToRating already holds for
-- an unrated stop (unrated → null, never a 1).
--
-- And it adds NOTHING to the Next compile graph, which the current next-build
-- heap headroom (CLAUDE.md §8) asks of anything built this wave.
--
-- THE VISIT-WINDOW CHECK spans TWO columns, so it is invisible to
-- scripts/generate-check-vocabularies.ts (whose SQL filters
-- array_length(con.conkey,1) = 1) and does NOT invalidate
-- scripts/check-vocabularies.ts. The column name is unchanged, so the alphabetical
-- column list in scripts/schema-snapshot.ts is unchanged too.

BEGIN;

-- ── APPLY-TIME GUARD ────────────────────────────────────────────────────────
-- Dropping the column destroys whatever is in it. It is empty today, and this
-- migration must REFUSE rather than silently discard data if that ever stops
-- being true between writing and applying (CLAUDE.md §3 — files are not the
-- database, and the gap between the two is where this class of loss lives).
DO $$
DECLARE populated bigint;
BEGIN
  SELECT count(time_spent_minutes) INTO populated FROM public.tour_stops;
  IF populated > 0 THEN
    RAISE EXCEPTION
      'm564 REFUSED: % tour_stops rows carry a hand-written time_spent_minutes. '
      'Converting the column to GENERATED would discard them. Reconcile those rows '
      'against time_arrived_at/time_left_at first.', populated;
  END IF;
END $$;

-- ── 1. A departure cannot precede an arrival ────────────────────────────────
-- Without this, a swapped or skewed stamp produces a NEGATIVE interval. Refusing
-- the write is honest; silently storing a negative duration, or quietly clamping
-- it to zero, is not. NULLs pass — a visit still in progress is a legitimate
-- half-recorded state, not a violation.
ALTER TABLE public.tour_stops
  ADD CONSTRAINT tour_stops_visit_window_check
  CHECK (
    time_arrived_at IS NULL
    OR time_left_at IS NULL
    OR time_left_at >= time_arrived_at
  );

-- ── 2. time_spent_minutes becomes DERIVED, never asserted ───────────────────
ALTER TABLE public.tour_stops DROP COLUMN time_spent_minutes;

ALTER TABLE public.tour_stops
  ADD COLUMN time_spent_minutes integer
  GENERATED ALWAYS AS (
    CASE
      WHEN time_arrived_at IS NOT NULL
       AND time_left_at    IS NOT NULL
       AND time_left_at   >= time_arrived_at
      THEN (round(extract(epoch FROM (time_left_at - time_arrived_at)) / 60.0))::integer
      ELSE NULL
    END
  ) STORED;

COMMENT ON COLUMN public.tour_stops.time_spent_minutes IS
  'DERIVED, never written (m564). Minutes between time_arrived_at and time_left_at, '
  'rounded. NULL while either stamp is missing — an unfinished visit is not a '
  'zero-minute visit. Writers: app/actions/tour-planner.ts::stampTourStopPresence '
  'stamps the two timestamps; this column follows from them and refuses direct writes.';

COMMENT ON COLUMN public.tour_stops.time_arrived_at IS
  'Day-of check-IN, stamped server-side by app/actions/tour-planner.ts::stampTourStopPresence '
  'when the agent opens the stop on the tour-day navigator. First arrival wins.';

COMMENT ON COLUMN public.tour_stops.time_left_at IS
  'Day-of check-OUT, stamped server-side by app/actions/tour-planner.ts::stampTourStopPresence '
  'when the agent leaves the stop. Latest departure wins; refused before an arrival exists.';

COMMIT;
