-- =============================================================================
-- LAYER 8.5 — VIDEO PERFORMANCE TRACKING MIGRATION
-- =============================================================================
-- Tables:
--   video_engagement_events (raw event ledger)
--   video_performance_tracking (aggregate metrics)
--   video_assets (asset library)
--   ai_video_projects (video projects)
--
-- DO NOT create video_analytics table
-- =============================================================================

-- =============================================================================
-- 1. ENSURE video_engagement_events HAS EXTENDED EVENT TYPES
-- =============================================================================

-- Drop old enum if exists and recreate with all event types
DO $$
BEGIN
  -- Check if video_event_type enum exists
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'video_event_type') THEN
    -- Add new values if they don't exist
    BEGIN
      ALTER TYPE video_event_type ADD VALUE IF NOT EXISTS 'view';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER TYPE video_event_type ADD VALUE IF NOT EXISTS 'pause';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER TYPE video_event_type ADD VALUE IF NOT EXISTS 'complete';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER TYPE video_event_type ADD VALUE IF NOT EXISTS 'click';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER TYPE video_event_type ADD VALUE IF NOT EXISTS 'share';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER TYPE video_event_type ADD VALUE IF NOT EXISTS 'lead_capture';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER TYPE video_event_type ADD VALUE IF NOT EXISTS 'cta_click';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER TYPE video_event_type ADD VALUE IF NOT EXISTS 'replay';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  ELSE
    -- Create the enum with all values
    CREATE TYPE video_event_type AS ENUM (
      'view',
      'pause',
      'complete',
      'click',
      'share',
      'lead_capture',
      'cta_click',
      'replay'
    );
  END IF;
END $$;

-- =============================================================================
-- 2. UPDATE video_engagement_events TABLE SCHEMA
-- =============================================================================

-- Add missing columns if they don't exist
DO $$
BEGIN
  -- Add watch_duration_seconds if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'video_engagement_events' 
    AND column_name = 'watch_duration_seconds'
  ) THEN
    ALTER TABLE video_engagement_events ADD COLUMN watch_duration_seconds INTEGER DEFAULT 0;
  END IF;
  
  -- Ensure timestamp column exists and has correct type
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'video_engagement_events' 
    AND column_name = 'timestamp'
  ) THEN
    ALTER TABLE video_engagement_events ADD COLUMN timestamp TIMESTAMP WITH TIME ZONE DEFAULT now();
  END IF;
END $$;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_video_engagement_events_video_asset ON video_engagement_events(video_asset_id);
CREATE INDEX IF NOT EXISTS idx_video_engagement_events_contact ON video_engagement_events(contact_id);
CREATE INDEX IF NOT EXISTS idx_video_engagement_events_timestamp ON video_engagement_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_video_engagement_events_type ON video_engagement_events(event_type);

-- =============================================================================
-- 3. ENSURE video_performance_tracking TABLE EXISTS WITH CORRECT SCHEMA
-- =============================================================================

-- The table already exists per the schema dump, but ensure all columns are present
DO $$
BEGIN
  -- Add brokerage_id if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'video_performance_tracking' 
    AND column_name = 'brokerage_id'
  ) THEN
    ALTER TABLE video_performance_tracking ADD COLUMN brokerage_id UUID REFERENCES brokerages(id);
  END IF;
  
  -- Add video_asset_id if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'video_performance_tracking' 
    AND column_name = 'video_asset_id'
  ) THEN
    ALTER TABLE video_performance_tracking ADD COLUMN video_asset_id UUID REFERENCES video_assets(id);
  END IF;
  
  -- Add last_event_at if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'video_performance_tracking' 
    AND column_name = 'last_event_at'
  ) THEN
    ALTER TABLE video_performance_tracking ADD COLUMN last_event_at TIMESTAMP WITH TIME ZONE;
  END IF;
  
  -- Add unique_views if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'video_performance_tracking' 
    AND column_name = 'unique_views'
  ) THEN
    ALTER TABLE video_performance_tracking ADD COLUMN unique_views INTEGER DEFAULT 0;
  END IF;
  
  -- Add share_rate if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'video_performance_tracking' 
    AND column_name = 'share_rate'
  ) THEN
    ALTER TABLE video_performance_tracking ADD COLUMN share_rate NUMERIC DEFAULT 0;
  END IF;
END $$;

-- Create indexes for video_performance_tracking
CREATE INDEX IF NOT EXISTS idx_video_performance_tracking_brokerage ON video_performance_tracking(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_video_performance_tracking_video_asset ON video_performance_tracking(video_asset_id);
CREATE INDEX IF NOT EXISTS idx_video_performance_tracking_video_project ON video_performance_tracking(video_project_id);
CREATE INDEX IF NOT EXISTS idx_video_performance_tracking_views ON video_performance_tracking(total_views DESC);

-- =============================================================================
-- 4. RLS POLICIES FOR video_performance_tracking
-- =============================================================================

-- Enable RLS if not already enabled
ALTER TABLE video_performance_tracking ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist and recreate
DROP POLICY IF EXISTS vpt_brokerage ON video_performance_tracking;

-- Policy: Users can access performance data for their brokerage
CREATE POLICY vpt_brokerage ON video_performance_tracking
  FOR ALL
  USING (
    brokerage_id IN (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM users WHERE id = auth.uid() AND platform_role IN ('superadmin', 'admin')
    )
  );

-- =============================================================================
-- 5. GRANT PERMISSIONS
-- =============================================================================

GRANT SELECT, INSERT, UPDATE ON video_engagement_events TO authenticated;
GRANT SELECT, INSERT, UPDATE ON video_performance_tracking TO authenticated;
GRANT SELECT, INSERT, UPDATE ON video_engagement_events TO service_role;
GRANT SELECT, INSERT, UPDATE ON video_performance_tracking TO service_role;

-- =============================================================================
-- 6. MIGRATION COMPLETE
-- =============================================================================

SELECT 'Layer 8.5 Video Performance Tracking migration complete' AS status;
