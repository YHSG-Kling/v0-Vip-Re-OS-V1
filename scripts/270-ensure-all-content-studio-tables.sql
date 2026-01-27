-- Ensure all content studio tables exist with proper columns

-- Make sure content_ideas has all required columns
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='content_ideas' AND column_name='created_by') THEN
    ALTER TABLE content_ideas ADD COLUMN created_by UUID REFERENCES users(id);
  END IF;
END $$;

-- Make sure video_scripts table exists
CREATE TABLE IF NOT EXISTS video_scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES users(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  script_text TEXT NOT NULL,
  persona TEXT,
  video_type TEXT CHECK (video_type IN ('introduction', 'property-tour', 'market-update', 'closing-celebration', 'check-in', 'custom')) DEFAULT 'custom',
  status TEXT CHECK (status IN ('draft', 'approved', 'video-generated', 'sent')) DEFAULT 'draft',
  validation_score INTEGER CHECK (validation_score >= 0 AND validation_score <= 100),
  validation_notes TEXT,
  video_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for video_scripts
CREATE INDEX IF NOT EXISTS idx_video_scripts_agent ON video_scripts(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_video_scripts_contact ON video_scripts(contact_id);

-- Add RLS policies for video_scripts
ALTER TABLE video_scripts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own video scripts" ON video_scripts;
CREATE POLICY "Users can view their own video scripts" ON video_scripts
  FOR SELECT USING (auth.uid() = agent_id);

DROP POLICY IF EXISTS "Users can insert their own video scripts" ON video_scripts;
CREATE POLICY "Users can insert their own video scripts" ON video_scripts
  FOR INSERT WITH CHECK (auth.uid() = agent_id);

DROP POLICY IF EXISTS "Users can update their own video scripts" ON video_scripts;
CREATE POLICY "Users can update their own video scripts" ON video_scripts
  FOR UPDATE USING (auth.uid() = agent_id);

-- Ensure generated_content table exists for fallback
CREATE TABLE IF NOT EXISTS generated_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES users(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_generated_content_agent ON generated_content(agent_id);
