-- WRITTEN, NOT APPLIED (wave 147, lane 147B) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN are owner SQL-editor
--
-- m893 — movement_source_polls: the POLL-AND-DIFF WATCHER'S FRESHNESS, published per tenant × source (wave 147, lane 147B — owner
-- ruling 3: "including providers that have no push signal (poll-and-diff is the fallback, with its freshness published)").
--
-- One row per (brokerage, watched source): when the watcher last polled, when it last SUCCEEDED (a failed poll, or a poll whose
-- raises were refused, leaves last_success_at where it was — so staleness shows instead of hiding), the cadence it runs at, and the
-- freshness it can honestly promise (cadence + the upstream sweep's published lag; NULL when the upstream lag is unpublished —
-- the watcher promises nothing it cannot keep).
--
-- WHY A NEW TABLE (audited 2026-10-31): no survivor records per-source poll state — service_status is a provider HEALTH row
-- (consecutive failures, response time) per service, not a tenant × source cursor; the existing sweeps keep no cursor at all
-- (permit-signals re-reads its dedupe keys; the 145F / 146D watchers use a fixed overlapping window). to_regclass is null live.
--
-- Writer: lib/intent/movement-source-watcher.ts (supabaseWatchStore.savePoll, upsert on the unique key). Reader: the same watcher
-- (due / baseline) and the lead desk (freshness). After applying: regenerate scripts/schema-snapshot.ts, scripts/live-tables.ts,
-- scripts/schema-fk-map.ts (1 FK); TABLE_MANAGER 'movement_source_polls' -> data_steward (lane 147I).

CREATE TABLE IF NOT EXISTS public.movement_source_polls (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id                uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  source_key                  text        NOT NULL,
  cadence_minutes             integer     NULL CHECK (cadence_minutes IS NULL OR cadence_minutes > 0),
  last_polled_at              timestamptz NULL,
  last_success_at             timestamptz NULL,
  last_error                  text        NULL,
  last_item_count             integer     NOT NULL DEFAULT 0 CHECK (last_item_count >= 0),
  last_change_count           integer     NOT NULL DEFAULT 0 CHECK (last_change_count >= 0),
  promised_freshness_minutes  integer     NULL CHECK (promised_freshness_minutes IS NULL OR promised_freshness_minutes > 0),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT movement_source_polls_unique UNIQUE (brokerage_id, source_key)
);

COMMENT ON TABLE public.movement_source_polls IS
  'Wave 147 (147B, ruling 3): per tenant × watched no-push source — last poll, last SUCCESS, cadence, and the freshness the watcher can honestly promise (NULL = upstream lag unpublished). Writer lib/intent/movement-source-watcher.ts.';

ALTER TABLE public.movement_source_polls ENABLE ROW LEVEL SECURITY;

CREATE POLICY movement_source_polls_lead_desk_read ON public.movement_source_polls
  FOR SELECT TO authenticated
  USING (brokerage_id = public.current_user_brokerage_id() AND public.is_lead_visible_role());

REVOKE INSERT, UPDATE, DELETE ON public.movement_source_polls FROM authenticated, anon;
GRANT SELECT ON public.movement_source_polls TO authenticated;

-- VERIFY (read-only, after applying):
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.movement_source_polls'::regclass ORDER BY 1;
--   SELECT count(*) FROM public.movement_source_polls;   -- 0 on first apply
