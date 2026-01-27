-- Migration: Add HeyGen settings and video queue table
-- This script creates the video_content_queue table for video generation tracking

-- Add HeyGen settings to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS heygen_avatar_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS heygen_voice_id TEXT;

-- Create video_content_queue table for video generation tracking
CREATE TABLE IF NOT EXISTS video_content_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  title TEXT NOT NULL,
  script TEXT NOT NULL,
  video_type TEXT CHECK (video_type IN ('avatar', 'voice')) NOT NULL,
  heygen_avatar_id TEXT,
  heygen_voice_id TEXT,
  status TEXT CHECK (status IN ('queued', 'processing', 'completed', 'failed')) DEFAULT 'queued',
  heygen_video_id TEXT,
  video_url TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Add RLS policies
ALTER TABLE video_content_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own video queue" ON video_content_queue
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users can insert own videos" ON video_content_queue
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Service role has full access" ON video_content_queue
  FOR ALL USING (true);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_video_queue_user ON video_content_queue(user_id);
CREATE INDEX IF NOT EXISTS idx_video_queue_status ON video_content_queue(status);
CREATE INDEX IF NOT EXISTS idx_video_queue_created ON video_content_queue(created_at DESC);
