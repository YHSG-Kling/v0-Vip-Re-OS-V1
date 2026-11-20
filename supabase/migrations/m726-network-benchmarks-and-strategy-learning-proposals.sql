-- ── APPLIED LIVE 2026-10-06 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m726 — PRIVACY-SAFE NETWORK BENCHMARKS + STRATEGY LEARNING PROPOSALS (wave 107, lane 107F).
-- Owner: "Do not mix tenants' private records … anonymized/aggregated benchmarks … without seeing another
-- brokerage's data." + "Strategy B works platform-wide, but Strategy A works better for this brokerage."
--
-- SURVIVORS EVALUATED: no cross-tenant aggregate table exists (territory-marketplace.ts anonymizes ONE board in
-- memory; brokerage_intelligence_insights / territory_metrics are per-tenant). improvement_proposals (m709/m721)
-- is the ONE proposal object — the strategy finding rides it (no second table).
--
-- network_benchmarks: platform-level, NO tenant column, NO person column, NO free text (every segment value is a
-- short vocabulary token by CHECK). Written ONLY by the platform cron through the service role
-- (lib/intelligence/network-benchmarks.ts runNetworkBenchmarkAggregation); a cell exists only when ≥ k_min
-- tenants and ≥ n_min events contributed (k ≥ 3, n ≥ 10 enforced here too). Read by every authenticated user.
--
-- Apply in TWO parts (wave 98 rule). PART B widens the m721 CHECKs as the SUPERSET (latest-definer rule):
-- if lane 107E also widens improvement_proposals CHECKs, the integrator restates the union in the
-- highest-numbered migration. AFTER APPLYING: add network_benchmarks to scripts/live-tables.ts +
-- schema-snapshot (delta regen), regenerate scripts/check-vocabularies.ts, and restamp line 1.

-- ══════════════════════════════ PART A — table, CHECKs, RLS ══════════════════════════════
CREATE TABLE IF NOT EXISTS public.network_benchmarks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  metric          text NOT NULL,
  market_band     text,
  strategy_key    text,
  channel         text,
  provider        text,
  content_kind    text,
  competency      text,
  cell_key        text NOT NULL,
  rate            numeric,
  sample_size     integer NOT NULL DEFAULT 0,
  mean            numeric,
  tenant_count    integer NOT NULL,
  event_count     integer NOT NULL,
  k_min           integer NOT NULL,
  n_min           integer NOT NULL,
  policy_version  text NOT NULL,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_benchmarks_metric_check CHECK (metric IN ('seller_campaign_conversion', 'brokerage_conversion', 'strategy_conversion', 'provider_reliability', 'channel_response', 'content_performance', 'education_effectiveness')),
  CONSTRAINT network_benchmarks_k_anonymity_check CHECK (k_min >= 3 AND n_min >= 10 AND tenant_count >= k_min AND event_count >= n_min),
  CONSTRAINT network_benchmarks_segment_tokens_check CHECK (
    (market_band  IS NULL OR market_band  ~ '^[a-z0-9][a-z0-9_.@-]{0,63}$') AND
    (strategy_key IS NULL OR strategy_key ~ '^[a-z0-9][a-z0-9_.@-]{0,63}$') AND
    (channel      IS NULL OR channel      ~ '^[a-z0-9][a-z0-9_.@-]{0,63}$') AND
    (provider     IS NULL OR provider     ~ '^[a-z0-9][a-z0-9_.@-]{0,63}$') AND
    (content_kind IS NULL OR content_kind ~ '^[a-z0-9][a-z0-9_.@-]{0,63}$') AND
    (competency   IS NULL OR competency   ~ '^[a-z0-9][a-z0-9_.@-]{0,63}$')),
  CONSTRAINT network_benchmarks_rate_check CHECK (rate IS NULL OR (rate >= 0 AND rate <= 1000000)),
  CONSTRAINT network_benchmarks_period_cell_key UNIQUE (period_end, cell_key)
);

ALTER TABLE public.network_benchmarks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS network_benchmarks_read_all ON public.network_benchmarks;
CREATE POLICY network_benchmarks_read_all ON public.network_benchmarks FOR SELECT TO authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON public.network_benchmarks FROM anon, authenticated;

COMMENT ON TABLE public.network_benchmarks IS
  'm726 (wave 107F): k-anonymous platform benchmarks — no tenant / person column, no free text. Writer: lib/intelligence/network-benchmarks.ts runNetworkBenchmarkAggregation (platform cron, service role, opted-in tenants only). Readers: readNetworkBenchmarks / benchmarksBeside, strategy-learning platform scope.';

-- ══════════════════════════════ PART B — proposal vocabulary (superset of m721) ══════════════════════════════
ALTER TABLE public.improvement_proposals DROP CONSTRAINT IF EXISTS improvement_proposals_subject_kind_check;
ALTER TABLE public.improvement_proposals ADD CONSTRAINT improvement_proposals_subject_kind_check
  CHECK (subject_kind IN ('policy', 'prompt', 'variant', 'threshold', 'allocation', 'strategy'));

ALTER TABLE public.improvement_proposals DROP CONSTRAINT IF EXISTS improvement_proposals_proposer_check;
ALTER TABLE public.improvement_proposals ADD CONSTRAINT improvement_proposals_proposer_check
  CHECK (proposer IN ('copy_learning', 'predictor_learning', 'prompt_calibrator', 'outcome_autopsy', 'human', 'media_intelligence', 'resource_allocation', 'strategy_learning'));

CREATE INDEX IF NOT EXISTS network_benchmarks_period_metric_idx ON public.network_benchmarks (period_end DESC, metric);
