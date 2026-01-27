-- =====================================================
-- EVENTS & ORCHESTRATOR SYSTEM
-- Migration: 100
-- =====================================================

-- =====================================================
-- 1. EVENTS TABLE - Central event log for all system activities
-- =====================================================

CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  source TEXT NOT NULL CHECK (source IN ('ui', 'webhook', 'system', 'cron')),
  dedupe_key TEXT,
  processed BOOLEAN DEFAULT false,
  processed_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_events_brokerage_created ON events(brokerage_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_dedupe ON events(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_unprocessed ON events(processed, created_at) WHERE NOT processed;
CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);

-- RLS Policies
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view events in their brokerage"
  ON events
  FOR SELECT
  USING (
    brokerage_id IN (SELECT auth.user_brokerage_ids())
  );

CREATE POLICY "Users can insert events in their brokerage"
  ON events
  FOR INSERT
  WITH CHECK (
    brokerage_id IN (SELECT auth.user_brokerage_ids())
  );

CREATE POLICY "Admins can manage all events in their brokerage"
  ON events
  FOR ALL
  USING (
    auth.user_is_admin() AND 
    brokerage_id IN (SELECT auth.user_brokerage_ids())
  );

-- =====================================================
-- 2. EVENT PROCESSING LOG - Track orchestrator actions
-- =====================================================

CREATE TABLE IF NOT EXISTS event_processing_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID REFERENCES events(id) ON DELETE CASCADE,
  handler TEXT NOT NULL,
  status TEXT CHECK (status IN ('success', 'failure', 'skipped')) NOT NULL,
  error_message TEXT,
  processing_time_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_processing_log_event_id ON event_processing_log(event_id);
CREATE INDEX IF NOT EXISTS idx_event_processing_log_status ON event_processing_log(status, created_at DESC);

-- RLS for event_processing_log
ALTER TABLE event_processing_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view processing logs for their events"
  ON event_processing_log
  FOR SELECT
  USING (
    event_id IN (
      SELECT id FROM events 
      WHERE brokerage_id IN (SELECT auth.user_brokerage_ids())
    )
  );

-- =====================================================
-- 3. HELPER FUNCTIONS
-- =====================================================

-- Check if event already processed (idempotency)
CREATE OR REPLACE FUNCTION is_event_duplicate(p_dedupe_key TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM events 
    WHERE dedupe_key = p_dedupe_key 
    AND created_at > NOW() - INTERVAL '24 hours'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get unprocessed events for background processing
CREATE OR REPLACE FUNCTION get_unprocessed_events(p_limit INTEGER DEFAULT 100)
RETURNS TABLE (
  id UUID,
  brokerage_id UUID,
  user_id UUID,
  event_type TEXT,
  payload JSONB,
  source TEXT,
  dedupe_key TEXT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    e.id, e.brokerage_id, e.user_id, e.event_type, 
    e.payload, e.source, e.dedupe_key, e.created_at
  FROM events e
  WHERE NOT e.processed
  ORDER BY e.created_at ASC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- 4. COMMENTS & DOCUMENTATION
-- =====================================================

COMMENT ON TABLE events IS 'Central event log for all system activities with idempotency support';
COMMENT ON TABLE event_processing_log IS 'Audit trail of how each event was processed by the orchestrator';
COMMENT ON COLUMN events.dedupe_key IS 'Unique key for idempotency - prevents duplicate processing within 24 hours';
COMMENT ON COLUMN events.processed IS 'Flag indicating if this event has been processed by the orchestrator';
COMMENT ON COLUMN events.error IS 'Error message if event processing failed';
COMMENT ON COLUMN events.event_type IS 'Event types: lead.created, lead.tagged_hot, listing.appointment_set, listing.signed, listing.live, transaction.milestone_overdue, credit.status_updated, video.generated, etc.';
