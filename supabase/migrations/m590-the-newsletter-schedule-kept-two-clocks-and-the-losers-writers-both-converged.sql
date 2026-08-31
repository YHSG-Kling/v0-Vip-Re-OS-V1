-- m590 — newsletter_scheduled_sends: drop scheduled_send_time, the schedule
--        column that lost both its writers and never had a reader
-- ─────────────────────────────────────────────────────────────────────────────
-- STATUS: WRITTEN, NOT APPLIED. Lanes write migrations; only the integrator
-- applies them (CLAUDE.md §3). Written by lane M5, 2026-08-31, finishing the
-- loop L2 flagged when it converged the writers.
--
-- ── THE §6 SPLIT, AND ITS RESOLUTION (already shipped in code) ──────────────
-- The table carried TWO spellings of "when this issue goes out":
--
--     scheduled_time        timestamp without time zone   ← SURVIVOR
--     scheduled_send_time   timestamp with time zone      ← this drop
--
-- Survivor chosen on READER evidence: every reader in the tree reads
-- scheduled_time — the campaign-ROI window filter
-- (lib/campaigns/roi-calculator.ts:365) and the marketing studio's send list
-- (app/dashboard/marketing/.../marketing-studio-client.tsx:2525). Nothing
-- ever read scheduled_send_time, so rows written through the action lane
-- (which wrote ONLY scheduled_send_time) were invisible to the channel-ROI
-- window forever. Both writers have since CONVERGED onto the survivor:
--
--     app/actions/newsletter/schedule-newsletter.ts:175  writes scheduled_time
--     lib/kernel/marketing.ts:444                        writes scheduled_time
--
-- which leaves scheduled_send_time with NO writer and NO reader — a §1.1
-- duplicate whose merge is already done; this file is the deletion half, and
-- the tombstones at both writers name the survivor.
--
-- ── EVIDENCE, measured 2026-08-31 ───────────────────────────────────────────
-- · Code: stripped-source scan (scripts/strip-comments.ts stripComments +
--   blankStrings, §2 — a tombstone is not a call site) over app/ lib/
--   components/ scripts/ types/: 3 files raw-mention the name, 0 live code
--   tokens survive the strip. All 3 are the two writer tombstones and the
--   generated schema cache. POSITIVE CONTROL: the same finder still sees the
--   survivor's insert key `scheduled_time:` in schedule-newsletter.ts.
--   Blind spots: .sql files (checked by eye: only scripts/590-create-
--   newsletter-system-schema.sql, the never-the-database bootstrap file, which
--   also declares the column NOT NULL + indexed — the LIVE column is nullable
--   with no index, proof that file does not describe the database, §3).
-- · Not a hidden writer: no migration backfill targets it, no .rpc() writes
--   the table, and pg column default is NULL (checked below) — the three
--   "reads as writerless without being writerless" traps in §3 are ruled out.
-- · Live (hrvaqgvukzxfskkcrwbt, 2026-08-31, information_schema + pg_indexes):
--       row count: 0  (nonnull scheduled_send_time: 0) → NO BACKFILL NEEDED
--       scheduled_send_time: timestamptz, is_nullable=YES, no default
--       indexes on the table: newsletter_scheduled_sends_pkey ONLY (the
--       bootstrap file's idx_scheduled_sends_send_time does not exist live,
--       so there is no dependent index to drop first)
--
-- ── CACHES THAT NAME THE COLUMN (integrator: regenerate AFTER applying) ─────
-- scripts/schema-snapshot.ts:443 lists scheduled_send_time in the
-- newsletter_scheduled_sends column set. Generated, never hand-edited (§3) —
-- regenerate via its header's SQL after this is applied, or
-- test:schema-drift / test:schema-cache-drift will (correctly) disagree with
-- the database. No CHECK is touched, so check-vocabularies.ts is unaffected;
-- live-tables.ts and schema-fk-map.ts do not name columns of this table.
--
-- ── AFTER-APPLY VERIFICATION (run it, do not trust this file) ───────────────
--   select count(*) as should_be_zero
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name   = 'newsletter_scheduled_sends'
--      and column_name  = 'scheduled_send_time';
--   → 0. And the survivor must still be there:
--   select count(*) as should_be_one
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name   = 'newsletter_scheduled_sends'
--      and column_name  = 'scheduled_time';
--   → 1.
-- ─────────────────────────────────────────────────────────────────────────────

-- Fail loudly if a writer reappeared between writing and applying: the table
-- was empty with zero non-null values when this was written. This asserts the
-- RULE (the column is unused), not a waypoint row count — any non-null value
-- means a writer exists again and the drop must be re-argued, not forced.
do $$
declare
  n bigint;
begin
  execute 'select count(*) from public.newsletter_scheduled_sends where scheduled_send_time is not null' into n;
  if n > 0 then
    raise exception 'm590 refused: % row(s) carry scheduled_send_time — a writer reappeared; re-verify before dropping', n;
  end if;
end $$;

alter table public.newsletter_scheduled_sends
  drop column if exists scheduled_send_time;
