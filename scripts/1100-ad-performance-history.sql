-- 1100: ad_performance_history — the time-series the ads stack lacked (ad_performance kept only the
-- latest snapshot, so creative fatigue / CTR decay was invisible). Each row is one CTR/cost reading
-- per campaign (optionally per creative) so the Creative-Fatigue Monitor can measure decay over a
-- 14-21 day window and propose a refresh. Additive, decoupled (no FK to ad tables), tenant-scoped.
-- Applied live via Supabase MCP migration `create_ad_performance_history`.

CREATE TABLE IF NOT EXISTS ad_performance_history (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id   uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  ad_campaign_id uuid,
  ad_creative_id uuid,
  captured_at    timestamptz NOT NULL DEFAULT now(),
  ctr            numeric,
  impressions    integer,
  clicks         integer,
  leads          integer,
  cost_per_lead  numeric,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aph_campaign  ON ad_performance_history(ad_campaign_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_aph_brokerage ON ad_performance_history(brokerage_id, captured_at);

ALTER TABLE ad_performance_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY ad_perf_history_service ON ad_performance_history FOR ALL TO service_role USING (true) WITH CHECK (true);
