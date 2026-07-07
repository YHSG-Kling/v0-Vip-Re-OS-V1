-- l26-s01-signal-entity-index.sql — the per-entity timeline read path. The
-- seller portal's team timeline and the Deal Play cohort query both filter
-- manager_signals by (entity_type, entity_id); only inbox/recency indexes
-- existed, so those reads were sequential scans.
CREATE INDEX IF NOT EXISTS idx_manager_signals_entity
  ON public.manager_signals (brokerage_id, entity_type, entity_id, created_at DESC);
