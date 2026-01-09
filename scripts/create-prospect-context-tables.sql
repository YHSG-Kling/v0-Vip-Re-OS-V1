-- Create prospects table to store prospect information
CREATE TABLE IF NOT EXISTS prospects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create prospect_context table to store emotional and situational context
CREATE TABLE IF NOT EXISTS prospect_context (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  emotion TEXT,
  situation TEXT,
  pain_point TEXT,
  timeline TEXT,
  life_context TEXT,
  what_helps TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(prospect_id)
);

-- Create generated_content table to track all generated content
CREATE TABLE IF NOT EXISTS generated_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID REFERENCES prospects(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL, -- 'email', 'text', 'social', 'newsletter'
  content TEXT NOT NULL,
  quality_score NUMERIC(3,2),
  them_percentage NUMERIC(5,2),
  agent_percentage NUMERIC(5,2),
  warnings JSONB,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_prospect_context_prospect_id ON prospect_context(prospect_id);
CREATE INDEX IF NOT EXISTS idx_generated_content_prospect_id ON generated_content(prospect_id);
CREATE INDEX IF NOT EXISTS idx_generated_content_type ON generated_content(content_type);
