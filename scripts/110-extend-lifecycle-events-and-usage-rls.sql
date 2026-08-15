-- =====================================================
-- Migration 110: Extend lifecycle_events + add RLS on usage tables
-- =====================================================
-- The lifecycle_events table already exists but is missing columns
-- that the orchestrator and event-helpers.ts write.
-- We also add event_processing_log and RLS policies for
-- usage_logs, meter_readings, and cost_allocation.
-- =====================================================

-- ── 1. Extend lifecycle_events to include orchestrator fields ────────────────
ALTER TABLE lifecycle_events
  ADD COLUMN IF NOT EXISTS user_id        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payload        JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS source         TEXT CHECK (source IN ('ui', 'webhook', 'system', 'cron')) DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS dedupe_key     TEXT,
  ADD COLUMN IF NOT EXISTS processed      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS processed_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error          TEXT;

-- Indexes to support orchestrator queries
CREATE INDEX IF NOT EXISTS idx_le_brokerage_created   ON lifecycle_events(brokerage_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_le_event_type_created  ON lifecycle_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_le_dedupe              ON lifecycle_events(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_le_unprocessed         ON lifecycle_events(processed, created_at) WHERE NOT processed;
CREATE INDEX IF NOT EXISTS idx_le_user_id             ON lifecycle_events(user_id);

-- RLS on lifecycle_events
ALTER TABLE lifecycle_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'lifecycle_events' AND policyname = 'le_brokerage_select'
  ) THEN
    CREATE POLICY le_brokerage_select
      ON lifecycle_events FOR SELECT
      USING (brokerage_id = (
        SELECT brokerage_id FROM users WHERE id = auth.uid() LIMIT 1
      ));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'lifecycle_events' AND policyname = 'le_brokerage_insert'
  ) THEN
    CREATE POLICY le_brokerage_insert
      ON lifecycle_events FOR INSERT
      WITH CHECK (brokerage_id = (
        SELECT brokerage_id FROM users WHERE id = auth.uid() LIMIT 1
      ));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'lifecycle_events' AND policyname = 'le_service_all'
  ) THEN
    CREATE POLICY le_service_all
      ON lifecycle_events FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ── 2. Create event_processing_log if not exists ────────────────────────────
CREATE TABLE IF NOT EXISTS event_processing_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          UUID REFERENCES lifecycle_events(id) ON DELETE CASCADE,
  handler           TEXT NOT NULL,
  status            TEXT CHECK (status IN ('success', 'failure', 'skipped')) NOT NULL,
  error_message     TEXT,
  processing_time_ms INTEGER,
  brokerage_id      UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_epl_event_id   ON event_processing_log(event_id);
CREATE INDEX IF NOT EXISTS idx_epl_status     ON event_processing_log(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_epl_brokerage  ON event_processing_log(brokerage_id, created_at DESC);

ALTER TABLE event_processing_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'event_processing_log' AND policyname = 'epl_brokerage_select'
  ) THEN
    CREATE POLICY epl_brokerage_select
      ON event_processing_log FOR SELECT
      USING (brokerage_id = (
        SELECT brokerage_id FROM users WHERE id = auth.uid() LIMIT 1
      ));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'event_processing_log' AND policyname = 'epl_service_all'
  ) THEN
    CREATE POLICY epl_service_all
      ON event_processing_log FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ── 3. RLS policies for usage_logs ──────────────────────────────────────────
-- usage_logs has brokerage_id and agent_id but no RLS policies at all
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'usage_logs' AND policyname = 'ul_agent_own'
  ) THEN
    CREATE POLICY ul_agent_own
      ON usage_logs FOR SELECT
      USING (
        brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid() LIMIT 1)
        AND (
          agent_id = (SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1)
          OR EXISTS (
            SELECT 1 FROM users
            WHERE id = auth.uid()
            AND user_type IN ('broker', 'admin', 'superadmin')
          )
        )
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'usage_logs' AND policyname = 'ul_service_all'
  ) THEN
    CREATE POLICY ul_service_all
      ON usage_logs FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ── 4. RLS policies for meter_readings ──────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'meter_readings' AND policyname = 'mr_broker_select'
  ) THEN
    CREATE POLICY mr_broker_select
      ON meter_readings FOR SELECT
      USING (brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid() LIMIT 1));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'meter_readings' AND policyname = 'mr_service_all'
  ) THEN
    CREATE POLICY mr_service_all
      ON meter_readings FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ── 5. RLS policies for cost_allocation ─────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'cost_allocation' AND policyname = 'ca_broker_select'
  ) THEN
    CREATE POLICY ca_broker_select
      ON cost_allocation FOR SELECT
      USING (brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid() LIMIT 1));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'cost_allocation' AND policyname = 'ca_service_all'
  ) THEN
    CREATE POLICY ca_service_all
      ON cost_allocation FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ── 6. RLS policies for feature_usage_tracking ──────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'feature_usage_tracking' AND policyname = 'fut_broker_select'
  ) THEN
    CREATE POLICY fut_broker_select
      ON feature_usage_tracking FOR SELECT
      USING (brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid() LIMIT 1));
  END IF;
END $$;

COMMENT ON TABLE lifecycle_events IS
  'Kernel event log — extended with orchestrator fields (payload, source, dedupe_key, processed).';
COMMENT ON TABLE event_processing_log IS
  'Audit trail of how each lifecycle event was handled by the orchestrator.';
