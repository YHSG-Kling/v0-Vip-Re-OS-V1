-- ── APPLIED LIVE 2026-10-05 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m708 — brokerage_twin_snapshots (wave 104, lane 104B: BROKERAGE DIGITAL TWIN).
--
-- WHY A NEW TABLE (orphan doctrine §1.2 — no survivor fits a whole-twin row):
--   · revenue_protection_snapshots: snapshot_type CHECK is {daily,weekly,monthly,quarterly,ytd,lifetime}
--     and the money columns are the revenue-protection scorer's own; a twin row would be a lie there.
--   · brokerage_intelligence_insights: a MINED PATTERN (quartile lift per pattern_key), not state.
--   · income_forecast_snapshots: per AGENT forecast; property_smart_insights / team_heatmap_snapshots
--     (derived-snapshots.ts): property / ZIP grain.
-- The twin is ONE derived representation per tenant per instant (lib/kernel/brokerage-twin.ts
-- buildBrokerageTwin); the next build diffs against the previous row (previous_snapshot_id chain,
-- the same shape revenue_protection_snapshots / income_forecast_snapshots already use).
--
-- Until applied: the twin still builds (changed.baseline = true, persist.error names the refusal).
-- After applying: regenerate the schema caches (schema-snapshot, live-tables, FK map) so the
-- schema-drift guard sees the table; TABLE_MANAGER names data_steward (lib/kernel/manager-registry.ts).
--
-- PART 1 — table (apply first).
CREATE TABLE IF NOT EXISTS public.brokerage_twin_snapshots (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id         uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  -- NULL = the brokerage-wide twin; a team's board twin names its team.
  team_id              uuid        NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  -- The instant the twin describes (buildBrokerageTwin's `at`).
  at                   timestamptz NOT NULL,
  computed_at          timestamptz NOT NULL DEFAULT now(),
  -- The whole BrokerageTwin (now / changed / atRisk / capacity / objectives / economic / evidence).
  twin                 jsonb       NOT NULL,
  -- twinDigest(twinMeasures(twin)) — dedupe + change detection.
  digest               text        NOT NULL,
  previous_snapshot_id uuid        NULL REFERENCES public.brokerage_twin_snapshots(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.brokerage_twin_snapshots IS
  'Wave 104B: one derived operating representation (digital twin) per tenant per instant — lib/kernel/brokerage-twin.ts. Evidence of what the OS believed at `at`; the next build diffs against previous_snapshot_id.';

-- PART 2 — indexes + RLS (apply after part 1).
CREATE INDEX IF NOT EXISTS brokerage_twin_snapshots_tenant_at_idx
  ON public.brokerage_twin_snapshots (brokerage_id, team_id, at DESC);

ALTER TABLE public.brokerage_twin_snapshots ENABLE ROW LEVEL SECURITY;

-- Tenant admins read their own twin history; writes come only through the service role
-- (buildBrokerageTwin) — no INSERT/UPDATE/DELETE policy for authenticated.
DROP POLICY IF EXISTS brokerage_twin_snapshots_tenant_read ON public.brokerage_twin_snapshots;
CREATE POLICY brokerage_twin_snapshots_tenant_read ON public.brokerage_twin_snapshots
  FOR SELECT TO authenticated
  USING (brokerage_id = public.current_user_brokerage_id());

REVOKE INSERT, UPDATE, DELETE ON public.brokerage_twin_snapshots FROM authenticated, anon;
GRANT SELECT ON public.brokerage_twin_snapshots TO authenticated;
