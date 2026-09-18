-- ═════════════════════════════════════════════════════════════════════════════
-- ⚠  THE "NOT APPLIED" CLAIM BELOW IS STALE. THIS MIGRATION *IS* APPLIED.
--
--    MEASURED 2026-09-04 against hrvaqgvukzxfskkcrwbt's own migration ledger,
--    `supabase_migrations.schema_migrations`, which carries a row named
--    `m586_…`. It was one of TWENTY files in this directory whose header said
--    it had never run; all twenty were in the ledger. Nobody came back to
--    update the headers after applying them.
--
--    THE EVIDENCE IS ONE-DIRECTIONAL, AND THAT IS STATED RATHER THAN GLOSSED:
--    presence in the ledger PROVES a migration ran. ABSENCE PROVES NOTHING —
--    the ledger only records migrations applied through the migration tool, and
--    m599 and m602–m605 are all applied and all absent from it, because they
--    were executed as direct SQL. So this banner is written only onto files the
--    ledger positively vouches for.
--
--    The original header is preserved below unedited. It is the record of what
--    its author believed when they wrote it, and CLAUDE.md §3 is the reason the
--    belief was wrong: "a migration that exists as a .sql file has not been
--    applied" — which is true, and cuts both ways. A file cannot tell you it
--    ran, and it cannot tell you it did not.
--
--    scripts/migration-claim-guard.ts now holds this class shut.
-- ═════════════════════════════════════════════════════════════════════════════

-- m586 — the service catalogue: thirteen rows the health board reads, and the
--        repo never recorded.
--
-- APPLICATION STATUS: APPLIED to hrvaqgvukzxfskkcrwbt on 2026-08-29 by the
-- integrator (lanes write migrations, only the integrator applies them —
-- CLAUDE.md §3). It was a NO-OP, as the lane predicted and as the integrator
-- re-measured before applying: all thirteen rows already existed with exactly
-- the values stated here, so applying changed nothing but the migration ledger.
-- Verified AFTER applying — the NOT EXISTS guard held and inserted nothing:
--
--   select count(*) as platform_rows,
--          count(*) filter (where is_critical) as critical,
--          count(distinct service_key) as distinct_keys
--   from public.service_status where brokerage_id is null;
--   → platform_rows 13 · critical 5 · distinct_keys 13
--
-- This line is deliberately not left reading "WRITTEN, NOT APPLIED". CLAUDE.md
-- §2 names that exact string as a waypoint an assertion must never be pinned
-- to: during a multi-step migration every intermediate state is briefly true
-- and then permanently false, and a file that keeps claiming one after it has
-- stopped being true is how a guard ends up passing only while the repo lies.
--
-- ── WHAT THIS FIXES ─────────────────────────────────────────────────────────
--
-- The opposite-missing census reports category 1b — "column read by code,
-- written by NOBODY" — and it correctly EXEMPTS a column whose writer is an
-- applied .sql seed, because there is nothing for app code to write. It derives
-- that exemption OFFLINE, from supabase/migrations and scripts/*.sql, so CI
-- (which holds no database credentials) sees the evidence a developer does.
-- The census header names the catalogue tables that exemption is for, verbatim:
--
--     "The CATALOGUE tables — feature_flags, plan_limits,
--      remotion_compositions, service_status, video_templates — are populated
--      by seed INSERTs in migrations"
--
-- For `service_status` that sentence was ASPIRATIONAL. There is no
-- `INSERT INTO ... service_status` anywhere in this repository. The seed was
-- applied out of band and never recorded, which is the standing residual the
-- census's own coverage block warns about ("a table whose DDL never lands in
-- the repo"). So four columns were reported as read-by-code-written-by-nobody:
--
--     service_status.service_key       app/actions/system-health.ts:668
--     service_status.service_name      app/actions/system-health.ts:181
--     service_status.service_category  app/actions/system-health.ts:181
--     service_status.is_critical       app/actions/system-health.ts:181
--
-- and `is_critical` looked worse than the other three, because it carries
-- DEFAULT false — a CONSTANT default, which m583 was right to leave in the
-- findings — so the obvious reading was "the health board cannot mark anything
-- critical, therefore it cannot report an outage".
--
-- ── THE MEASUREMENT THAT SETTLES IT ─────────────────────────────────────────
--
-- Measured live on 2026-08-29 against hrvaqgvukzxfskkcrwbt:
--
--   select service_key, service_name, service_category, is_critical,
--          current_status, brokerage_id
--   from public.service_status order by service_category, service_key;
--
--   → 13 rows. All four columns populated on all thirteen. is_critical is TRUE
--     on five (anthropic, supabase_db, sendgrid, stripe, twilio) and false on
--     the other eight — so it is NOT reading its default, and the board CAN
--     distinguish a critical outage from a cosmetic one. Every row carries
--     brokerage_id IS NULL: this is the PLATFORM catalogue, shared by every
--     tenant, exactly as m406/m407 describe it.
--
-- The four columns are therefore SEED-WRITTEN, not writerless, and this file is
-- the seed. The remedy is the one the doctrine prescribes: teach the finder to
-- see the writer, never exempt the column by hand.
--
-- ── WHY THIRTEEN AND NOT FIFTEEN ────────────────────────────────────────────
--
-- m372 records the original seed as fifteen platform rows and DELETEs two of
-- them (the decommissioned providers). This file records the catalogue AS IT
-- STANDS — the thirteen survivors — so that re-applying it cannot resurrect
-- what m372 retired. That is also why every insert is guarded by NOT EXISTS
-- rather than ON CONFLICT: the table's only unique constraint is
-- UNIQUE (brokerage_id, service_key), and brokerage_id is NULL on every
-- platform row, so NULL never conflicts with NULL and ON CONFLICT would insert
-- a duplicate on every apply.
--
-- ── WHAT THIS FILE IS *NOT* ─────────────────────────────────────────────────
--
-- It is not a new writer for the catalogue, and no app-side writer should be
-- built for it. m409 states the ruling already in force, and it is deliberate:
-- service_status is "machine telemetry, not catalogue content — their only
-- writers are the health-check cron and the connector gateway, both on the
-- SERVICE client". The cron writes the ROLLUP columns (current_status,
-- last_checked_at, consecutive_failures, response_time_ms, error_message) at
-- app/api/cron/health-check/route.ts:425. The four columns above are the
-- catalogue's IDENTITY, set once when a provider is onboarded, and widening a
-- write path to them would let a non-platform account forge or clear an outage
-- on the surface every tenant reads to decide whether the platform is up —
-- which is precisely what m409 refused.

DO $$
DECLARE
  seeded CONSTANT jsonb := '[
    {"service_key":"quickbooks", "service_name":"QuickBooks",        "service_category":"accounting","is_critical":false},
    {"service_key":"xero",       "service_name":"Xero",              "service_category":"accounting","is_critical":false},
    {"service_key":"anthropic",  "service_name":"Anthropic AI",      "service_category":"ai",        "is_critical":true },
    {"service_key":"supabase_db","service_name":"Supabase Database", "service_category":"database",  "is_critical":true },
    {"service_key":"sendgrid",   "service_name":"SendGrid (Email)",  "service_category":"email",     "is_critical":true },
    {"service_key":"docusign",   "service_name":"DocuSign (E-Sign)", "service_category":"esign",     "is_critical":false},
    {"service_key":"dotloop",    "service_name":"DotLoop (E-Sign)",  "service_category":"esign",     "is_critical":false},
    {"service_key":"stripe",     "service_name":"Stripe (Payments)", "service_category":"payment",   "is_critical":true },
    {"service_key":"apify",      "service_name":"Apify",             "service_category":"scraper",   "is_critical":false},
    {"service_key":"batchdata",  "service_name":"BatchData API",     "service_category":"scraper",   "is_critical":false},
    {"service_key":"google_cse", "service_name":"Google CSE",        "service_category":"scraper",   "is_critical":false},
    {"service_key":"zenrows",    "service_name":"ZenRows API",       "service_category":"scraper",   "is_critical":false},
    {"service_key":"twilio",     "service_name":"Twilio (SMS)",      "service_category":"sms",       "is_critical":true }
  ]'::jsonb;
  r jsonb;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(seeded) LOOP
    -- NOT EXISTS, not ON CONFLICT: see the header. brokerage_id IS NULL on every
    -- platform row and NULL does not conflict with NULL under the unique index.
    INSERT INTO public.service_status (brokerage_id, service_key, service_name, service_category, is_critical)
    SELECT NULL, r->>'service_key', r->>'service_name', r->>'service_category', (r->>'is_critical')::boolean
    WHERE NOT EXISTS (
      SELECT 1 FROM public.service_status s
      WHERE s.brokerage_id IS NULL AND s.service_key = r->>'service_key'
    );
  END LOOP;

  -- current_status is NOT seeded here. It defaults to 'unknown', and 'unknown'
  -- is the honest starting state: no health check has run against a freshly
  -- seeded row yet, and app/actions/system-health.ts:216 already renders that as
  -- "System status is UNKNOWN, not operational" rather than as a clean bill of
  -- health. Seeding 'healthy' would be the exact failure CLAUDE.md §2 names —
  -- a board that reports fine because nobody looked.
  RAISE NOTICE 'm586: service catalogue recorded — % key(s) considered, % platform row(s) now present (expected 13).',
    jsonb_array_length(seeded),
    (SELECT count(*) FROM public.service_status WHERE brokerage_id IS NULL);
END $$;
