-- Add HeyGen video generation settings to users table
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS heygen_avatar_id TEXT,
ADD COLUMN IF NOT EXISTS heygen_voice_id TEXT;

-- Create video content queue table for tracking generated videos
CREATE TABLE IF NOT EXISTS video_content_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  script TEXT NOT NULL,
  video_type TEXT NOT NULL CHECK (video_type IN ('avatar', 'voice')),
  status TEXT DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  heygen_video_id TEXT,
  video_url TEXT,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE
);

-- Add RLS policies
ALTER TABLE video_content_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own video queue"
  ON video_content_queue FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own videos"
  ON video_content_queue FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_video_queue_user_status 
  ON video_content_queue(user_id, status);
