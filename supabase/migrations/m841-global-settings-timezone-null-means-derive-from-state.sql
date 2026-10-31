-- ── APPLIED LIVE 2026-10-24 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 143, lane 143H; statement by statement where the MCP held a batch ──
--
-- m841 — the tenant's timezone can say "not chosen" (CLAUDE.md §1: extend the survivor, build no second column).
--
-- AUDIT FIRST — the survivor verdicts this file rests on:
--   · The tenant timezone column ALREADY EXISTS: public.global_settings.timezone (written by the settings door,
--     app/actions/settings/update-global-settings.ts:30 allow-list; carried by tier snapshots, lib/platform/config-snapshots.ts:13
--     SNAPSHOT_GLOBAL_FIELDS; presence-read by lib/kernel/tenant-readiness.ts:228). brokerages and brokerage_settings carry
--     none — so a brokerages.timezone column would be a SECOND tenant-timezone spelling (§6) and is NOT added.
--   · The deadline / closing consumers do not read it. lib/transactions/cda-closing-policy.ts:252 resolveTenantTimeZone takes
--     { state, explicitZone } and its only caller, lib/transactions/cda-delivery-reaper.ts:141, passes { state } alone, so the
--     zone derives from the brokerage's STATE (lib/fatigue/after-hours.ts timeZoneForState) and every tenant that chose a zone
--     is ignored. lib/kernel/milestone-calendar-bridge.ts:61-64 reads a THIRD spelling (settings.primary_timezone, an untyped
--     field no writer sets) and falls back to 'UTC'.
--   · WHY THE COLUMN CANNOT BE PASSED AS explicitZone TODAY: it is NOT NULL DEFAULT 'America/New_York'. A tenant that never
--     chose reads 'America/New_York' — a California brokerage's CDA deadline would be computed in Eastern time, and nothing
--     distinguishes that default from a deliberate choice. (This is the wave-142 reason the resolver derives from state, and it
--     was right to.)
--
-- THE CHANGE: make the existing column able to say "not chosen". NULL = derive from the brokerage's state (then UTC, SAID in
--   resolveTenantTimeZone's `source`); a value = the tenant's explicit IANA zone. Two ALTER COLUMN statements; no table, no
--   new column, no data movement.
--
-- LIVE, READ 2026-10-23 (project hrvaqgvukzxfskkcrwbt, read-only): public.global_settings has 0 rows (the database has never
--   been operated) and timezone is `text NOT NULL DEFAULT 'America/New_York'` with no CHECK on it — so there is nothing to
--   backfill and no row whose meaning changes. Run-time readers of the column: tenant-readiness.ts:228 is null-safe
--   (`c.gs.timezone ?? null`); no other runtime file reads it (grep 2026-10-23: every file that queries global_settings
--   was checked for a timezone access). lib/kernel/global-settings.ts:176 creates rows leaving timezone to "its DB default":
--   after this file such a row reads NULL, which is exactly the intended meaning ("the tenant has not chosen").
--
-- COUPLED CODE CHANGE (outside lane 143H — listed in the lane notes with file:line; the migration is safe WITHOUT it, it is
-- simply not yet USEFUL until it ships):
--   1. lib/transactions/cda-delivery-reaper.ts:141 — read global_settings.timezone for the transaction's brokerage (the same
--      session-derived brokerage id it already holds) and pass it as explicitZone.
--   2. lib/kernel/milestone-calendar-bridge.ts:61-64 — replace the untyped primary_timezone read with the same
--      resolveTenantTimeZone({ state, explicitZone }) call (ONE resolver), keeping 'UTC' only as the resolver's own fallback.
--   3. lib/kernel/global-settings.ts:17 — the row type becomes `timezone: string | null`; app/actions/settings/get-global-settings.ts:21
--      stops presenting 'America/New_York' as the no-row default (show "Use my state's time zone" instead).
--   4. app/components/settings/GeneralSettingsForm.tsx:59,354-360 — the form initialises `timezone` to 'America/New_York' when the
--      row has none, so SAVING an untouched form would persist Eastern time as if the tenant had chosen it; it must offer
--      "Use my state's time zone (default)" = NULL beside the IANA list and send NULL when that is selected.
--
-- ROLLBACK (loses no data while the table is empty; once rows exist, backfill first):
--   UPDATE public.global_settings SET timezone = 'America/New_York' WHERE timezone IS NULL;
--   ALTER TABLE public.global_settings ALTER COLUMN timezone SET DEFAULT 'America/New_York';
--   ALTER TABLE public.global_settings ALTER COLUMN timezone SET NOT NULL;

ALTER TABLE public.global_settings ALTER COLUMN timezone DROP NOT NULL;
ALTER TABLE public.global_settings ALTER COLUMN timezone DROP DEFAULT;

COMMENT ON COLUMN public.global_settings.timezone IS
  'The tenant''s EXPLICIT IANA time zone. NULL = not chosen: consumers derive the zone from the brokerage''s state (lib/transactions/cda-closing-policy.ts resolveTenantTimeZone), then UTC. m841 (wave 143).';
